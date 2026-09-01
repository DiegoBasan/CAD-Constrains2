import * as THREE from "three";
import type { ImportedPart, Pose } from "../occ/types";
import { relationResiduals, resolveEntity, type Relation } from "./relations";

export interface SolveInput {
  parts: Map<string, ImportedPart>;
  poses: Map<string, Pose>;
  fixedPartIds: Set<string>;
  relations: Relation[];
}

export interface SolveResult {
  poses: Map<string, Pose>;
  residualNorm: number;
  iterations: number;
  converged: boolean;
}

const MAX_ITERATIONS = 100;
const CONVERGENCE_TOL = 1e-6;
const FD_EPS = 1e-5;
// Per-step trust-region caps. Position and rotation share one damping scalar (lambda)
// in the normal equations below, but they don't share a validity radius: a face far
// from a part's origin makes that part's rotation columns of the Jacobian large (they
// scale with the lever arm), so Gauss-Newton's "optimal" step is often dominated by a
// big rotation swing — valid only for genuinely small angles, since the quaternion exp
// map is linear-ish near zero but increasingly (and eventually, at 2*pi, degenerately)
// nonlinear beyond that. An uncapped step overshoots into that invalid region, the
// next linearization is built on a bad point, and the solver never recovers within the
// iteration budget. Capping each part's per-step position/rotation delta keeps every
// step inside the region the local linear model actually describes.
const MAX_POS_STEP = 10; // mm per accepted step
const MAX_ROT_STEP = 0.15; // rad per accepted step (~8.6°)
// Tikhonov regularization on each step (toward "no further movement this iteration") —
// a single relation between two free parts is massively under-constrained (1 residual,
// up to 12 DOF), so without this the normal equations are near-singular in the
// relation's null space and a step can pick an arbitrarily large, unhelpful motion in
// that null space. Small enough to be negligible next to any real constraint gradient,
// it just keeps the system full-rank and each step's null-space component minimal.
const REG_WEIGHT = 3e-3;
// Orientation constraints (parallel, concentric, planar) make the objective genuinely
// non-convex — a face's normal can align two different ways, and the landscape between
// those basins can trap plain gradient descent short of either. A few restarts from
// randomized free-part orientations are a cheap, standard way to escape that: each is a
// full, cheap solve, and we keep whichever converges best.
const RESTART_ATTEMPTS = 10;

function expMapDelta(rot: THREE.Vector3): THREE.Quaternion {
  const angle = rot.length();
  if (angle < 1e-9) return new THREE.Quaternion(0, 0, 0, 1);
  const axis = rot.clone().multiplyScalar(1 / angle);
  return new THREE.Quaternion().setFromAxisAngle(axis, angle);
}

/** Solves a Gaussian-eliminated dense linear system (A + lambda*diag(A)) x = b in place. Returns null if singular. */
function solveDamped(A: Float64Array, n: number, b: Float64Array, lambda: number): Float64Array | null {
  const M = new Float64Array(n * n);
  M.set(A);
  for (let i = 0; i < n; i++) M[i * n + i] += lambda * Math.max(A[i * n + i], 1e-6);
  const rhs = Float64Array.from(b);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let pivotVal = Math.abs(M[col * n + col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(M[row * n + col]);
      if (v > pivotVal) {
        pivotVal = v;
        pivotRow = row;
      }
    }
    if (pivotVal < 1e-14) return null;
    if (pivotRow !== col) {
      for (let k = 0; k < n; k++) {
        const tmp = M[col * n + k];
        M[col * n + k] = M[pivotRow * n + k];
        M[pivotRow * n + k] = tmp;
      }
      const tmp = rhs[col];
      rhs[col] = rhs[pivotRow];
      rhs[pivotRow] = tmp;
    }
    const pivot = M[col * n + col];
    for (let row = col + 1; row < n; row++) {
      const factor = M[row * n + col] / pivot;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) M[row * n + k] -= factor * M[col * n + k];
      rhs[row] -= factor * rhs[col];
    }
  }

  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = rhs[row];
    for (let k = row + 1; k < n; k++) sum -= M[row * n + k] * x[k];
    x[row] = sum / M[row * n + row];
  }
  return x;
}

interface OnceResult {
  poses: Map<string, Pose>;
  residualNorm: number;
  iterations: number;
  converged: boolean;
}

/** One full Gauss-Newton/Levenberg-Marquardt solve from a given starting pose for each
 * free part, on the exp-map manifold parametrization described above. */
function solveOnce(
  parts: Map<string, ImportedPart>,
  startPoses: Map<string, Pose>,
  freeIds: string[],
  relations: Relation[],
): OnceResult {
  const n = freeIds.length * 6;
  const basePoses = new Map(startPoses);
  const x = new Float64Array(n); // [dPos(3), dRot(3)] per free part, relative to basePoses

  function poseFor(partId: string, state: Float64Array): Pose {
    const base = basePoses.get(partId);
    if (!base) throw new Error(`Missing base pose for ${partId}`);
    const idx = freeIds.indexOf(partId);
    if (idx === -1) return base;
    const off = idx * 6;
    const dPos = new THREE.Vector3(state[off], state[off + 1], state[off + 2]);
    const dRot = new THREE.Vector3(state[off + 3], state[off + 4], state[off + 5]);
    const basePos = new THREE.Vector3(...base.position);
    const baseQuat = new THREE.Quaternion(...base.quaternion);
    const position = basePos.add(dPos);
    const quaternion = baseQuat.multiply(expMapDelta(dRot)).normalize();
    return {
      position: [position.x, position.y, position.z],
      quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
    };
  }

  function residuals(state: Float64Array): number[] {
    const out: number[] = [];
    for (const rel of relations) {
      const partA = parts.get(rel.a.partId);
      const partB = parts.get(rel.b.partId);
      if (!partA || !partB) continue;
      const poseA = poseFor(rel.a.partId, state);
      const poseB = poseFor(rel.b.partId, state);
      const a = resolveEntity(partA, rel.a, poseA);
      const b = resolveEntity(partB, rel.b, poseB);
      if (!a || !b) continue;
      out.push(...relationResiduals(rel, a, b));
    }
    return out;
  }

  let r = residuals(x);
  let lambda = 1e-3;
  let iterations = 0;
  let converged = false;

  for (; iterations < MAX_ITERATIONS; iterations++) {
    const m = r.length;
    if (m === 0) break;
    const norm = Math.sqrt(r.reduce((s, v) => s + v * v, 0));
    if (norm < CONVERGENCE_TOL) {
      converged = true;
      break;
    }

    // Numeric Jacobian (m x n) via central differences.
    const J: number[][] = new Array(m);
    for (let i = 0; i < m; i++) J[i] = new Array(n);
    for (let j = 0; j < n; j++) {
      const xp = Float64Array.from(x);
      xp[j] += FD_EPS;
      const rp = residuals(xp);
      const xm = Float64Array.from(x);
      xm[j] -= FD_EPS;
      const rm = residuals(xm);
      for (let i = 0; i < m; i++) J[i][j] = (rp[i] - rm[i]) / (2 * FD_EPS);
    }

    // Normal equations: A = J^T J, b = -J^T r
    const A = new Float64Array(n * n);
    const b = new Float64Array(n);
    for (let i = 0; i < m; i++) {
      const Ji = J[i];
      for (let p = 0; p < n; p++) {
        if (Ji[p] === 0) continue;
        b[p] -= Ji[p] * r[i];
        for (let q = p; q < n; q++) {
          A[p * n + q] += Ji[p] * Ji[q];
        }
      }
    }
    for (let p = 0; p < n; p++) for (let q = 0; q < p; q++) A[p * n + q] = A[q * n + p];

    const reg2 = REG_WEIGHT * REG_WEIGHT;
    for (let i = 0; i < n; i++) A[i * n + i] += reg2;

    let accepted = false;
    for (let attempt = 0; attempt < 12 && !accepted; attempt++) {
      const delta = solveDamped(A, n, b, lambda);
      if (!delta) {
        lambda *= 4;
        continue;
      }
      for (let idx = 0; idx < freeIds.length; idx++) {
        const off = idx * 6;
        const posNorm = Math.hypot(delta[off], delta[off + 1], delta[off + 2]);
        if (posNorm > MAX_POS_STEP) {
          const s = MAX_POS_STEP / posNorm;
          delta[off] *= s;
          delta[off + 1] *= s;
          delta[off + 2] *= s;
        }
        const rotNorm = Math.hypot(delta[off + 3], delta[off + 4], delta[off + 5]);
        if (rotNorm > MAX_ROT_STEP) {
          const s = MAX_ROT_STEP / rotNorm;
          delta[off + 3] *= s;
          delta[off + 4] *= s;
          delta[off + 5] *= s;
        }
      }
      const xTry = Float64Array.from(x);
      for (let i = 0; i < n; i++) xTry[i] += delta[i];
      const rTry = residuals(xTry);
      const normTry = Math.sqrt(rTry.reduce((s, v) => s + v * v, 0));
      if (normTry < norm) {
        // Re-center: fold the accepted step into basePoses and zero out `x`, so the
        // next iteration's dRot always starts near the origin. Left to accumulate
        // across all iterations, dRot's magnitude can be pushed toward 2*pi by a large
        // early step, right where the axis-angle exp map's differential degenerates
        // (sin(angle/2) -> 0) — the FD Jacobian goes to noise there and Gauss-Newton
        // can never recover. Re-centering keeps every local linearization in the exp
        // map's well-conditioned near-origin region.
        for (const id of freeIds) basePoses.set(id, poseFor(id, xTry));
        x.fill(0);
        r = rTry;
        lambda = Math.max(lambda * 0.5, 1e-8);
        accepted = true;
      } else {
        lambda *= 4;
      }
    }
    if (!accepted) break; // stuck — keep best-so-far
  }

  const outPoses = new Map(startPoses);
  for (const id of freeIds) outPoses.set(id, poseFor(id, x));
  const finalNorm = Math.sqrt(r.reduce((s, v) => s + v * v, 0));
  return { poses: outPoses, residualNorm: finalNorm, iterations, converged };
}

function randomPerturbedPoses(base: Map<string, Pose>, freeIds: string[]): Map<string, Pose> {
  const out = new Map(base);
  for (const id of freeIds) {
    const pose = base.get(id);
    if (!pose) continue;
    const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const angle = Math.random() * Math.PI * 2;
    const jitter = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    const quaternion = new THREE.Quaternion(...pose.quaternion).premultiply(jitter);
    out.set(id, { position: [...pose.position], quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] });
  }
  return out;
}

export function solveAssembly(input: SolveInput): SolveResult {
  const { parts, poses, fixedPartIds, relations } = input;
  const freeIds = Array.from(poses.keys()).filter((id) => !fixedPartIds.has(id));

  const outPoses = new Map(poses);
  if (freeIds.length === 0 || relations.length === 0) {
    return { poses: outPoses, residualNorm: 0, iterations: 0, converged: true };
  }

  let best = solveOnce(parts, poses, freeIds, relations);
  for (let attempt = 0; attempt < RESTART_ATTEMPTS && !best.converged; attempt++) {
    const candidate = solveOnce(parts, randomPerturbedPoses(poses, freeIds), freeIds, relations);
    if (candidate.residualNorm < best.residualNorm) best = candidate;
  }
  return best;
}

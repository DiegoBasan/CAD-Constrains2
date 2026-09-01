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

const MAX_ITERATIONS = 40;
const CONVERGENCE_TOL = 1e-6;
const FD_EPS = 1e-5;

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

export function solveAssembly(input: SolveInput): SolveResult {
  const { parts, poses, fixedPartIds, relations } = input;
  const freeIds = Array.from(poses.keys()).filter((id) => !fixedPartIds.has(id));
  const n = freeIds.length * 6;

  const outPoses = new Map(poses);
  if (n === 0 || relations.length === 0) {
    return { poses: outPoses, residualNorm: 0, iterations: 0, converged: true };
  }

  const basePoses = new Map(poses);
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

    let accepted = false;
    for (let attempt = 0; attempt < 8 && !accepted; attempt++) {
      const delta = solveDamped(A, n, b, lambda);
      if (!delta) {
        lambda *= 4;
        continue;
      }
      const xTry = Float64Array.from(x);
      for (let i = 0; i < n; i++) xTry[i] += delta[i];
      const rTry = residuals(xTry);
      const normTry = Math.sqrt(rTry.reduce((s, v) => s + v * v, 0));
      if (normTry < norm) {
        x.set(xTry);
        r = rTry;
        lambda = Math.max(lambda * 0.5, 1e-8);
        accepted = true;
      } else {
        lambda *= 4;
      }
    }
    if (!accepted) break; // stuck (over-constrained / conflicting relations) — keep best-so-far
  }

  for (const id of freeIds) outPoses.set(id, poseFor(id, x));
  const finalNorm = Math.sqrt(r.reduce((s, v) => s + v * v, 0));
  return { poses: outPoses, residualNorm: finalNorm, iterations, converged };
}

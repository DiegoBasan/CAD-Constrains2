import * as THREE from "three";
import type { AxisConstraint, ImportedPart, Pose } from "../occ/types";
import { relationResiduals, resolveEntity, type Relation } from "./relations";

export interface SolveInput {
  parts: Map<string, ImportedPart>;
  poses: Map<string, Pose>;
  fixedPartIds: Set<string>;
  relations: Relation[];
  /** Restart attempts on non-convergence (see RESTART_ATTEMPTS). Interactive per-frame
   * calls (a live drag, or one frame of keyframe playback) pass 0 — warm-started from
   * the previous frame they converge in a couple of iterations anyway, and a randomized
   * restart mid-gesture would visibly pop a part to an unrelated candidate pose. A
   * one-shot solve (release, or the final settle) keeps the default so it can still
   * escape a genuine local minimum. */
  restarts?: number;
  /** Per-part axis locks/limits (see PartState.axisLock/axisLimits in assembly/store.ts)
   * — enforced here as real weighted residuals, not just a UI-drag clamp, so a locked
   * or limited axis holds against *any* cause of movement (another relation, a rigid
   * link, a group drag), not only the user's own direct drag on that part. Sparse: only
   * parts that actually have a lock/limit need an entry. */
  axisConstraints?: Map<string, AxisConstraint>;
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
// that null space — including, across many chained per-frame solves during an
// interactive drag, a slow directionless drift through that null space (e.g. spin about
// a concentric relation's own axis) even though nothing is asking it to spin. Small
// enough to be negligible next to any real constraint gradient, it just keeps the
// system full-rank and each step's null-space component minimal.
const REG_WEIGHT = 0.02;
// Orientation constraints (parallel, concentric, planar) make the objective genuinely
// non-convex — a face's normal can align two different ways, and the landscape between
// those basins can trap plain gradient descent short of either. A few restarts from
// randomized free-part orientations are a cheap, standard way to escape that: each is a
// full, cheap solve, and we keep whichever converges best.
const RESTART_ATTEMPTS = 10;
// Both a locked POSITION and a locked ROTATION axis are true hard constraints now —
// see the delta-zeroing in the trust-region-cap loop (position) and
// applyRotationLockCorrection (rotation), both applied after every accepted step — so
// there's no lock *weight* to tune here any more: nothing can out-pull either one,
// however many relations compound against it or how large the mismatch. An earlier
// version enforced rotation locks as a heavily-weighted soft residual instead (dRot is
// an exp-map delta with no per-Euler-axis correspondence, so it looked like the only
// option), but a large enough compounding pull — e.g. two separate rigid links both
// landing on the same locked part — could still overwhelm any finite weight and rotate
// it well past its lock. Only a *limit* (an elastic boundary, not a fixed value) still
// needs a residual, for both position and rotation, comparatively gentle since it only
// has to be assertive right at its own boundary. Position residuals are in mm and
// rotation ones in degrees, matching relation residuals' existing units (see
// relations.ts) so they compete on comparable footing with the geometric relations
// they're up against.
const AXIS_LIMIT_WEIGHT_POS = 5;
const AXIS_LIMIT_WEIGHT_ROT = 2;

function expMapDelta(rot: THREE.Vector3): THREE.Quaternion {
  const angle = rot.length();
  if (angle < 1e-9) return new THREE.Quaternion(0, 0, 0, 1);
  const axis = rot.clone().multiplyScalar(1 / angle);
  return new THREE.Quaternion().setFromAxisAngle(axis, angle);
}

/** Hard-enforces a part's locked rotation axes by decomposing its solved quaternion to
 * Euler-XYZ, snapping any locked component back to `target` (captured once, from this
 * part's pose when the whole solve began), and rebuilding the quaternion — called on
 * every accepted step so the next iteration's linearization already sees the locked
 * axes exactly where they belong, the same way a locked position axis is enforced by
 * zeroing its Newton-step delta. Position passes through untouched. */
function applyRotationLockCorrection(pose: Pose, constraint: AxisConstraint | undefined, target: [number, number, number] | undefined): Pose {
  if (!constraint?.lock || !target) return pose;
  if (!constraint.lock.rx && !constraint.lock.ry && !constraint.lock.rz) return pose;
  const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...pose.quaternion), "XYZ");
  if (constraint.lock.rx) e.x = THREE.MathUtils.degToRad(target[0]);
  if (constraint.lock.ry) e.y = THREE.MathUtils.degToRad(target[1]);
  if (constraint.lock.rz) e.z = THREE.MathUtils.degToRad(target[2]);
  const corrected = new THREE.Quaternion().setFromEuler(e);
  return { position: pose.position, quaternion: [corrected.x, corrected.y, corrected.z, corrected.w] };
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
 * free part, on the exp-map manifold parametrization described above. Called with a
 * `startPoses` that already differs from a free part's last-solved pose (e.g. a live
 * drag or keyframe-playback interpolation seeding it with where the user/animation
 * wants it to be), the solve's minimum-norm correction back onto the constraint
 * manifold *is* the "move only along the DOF the relations actually leave free"
 * behavior — Newton's method doesn't undo progress made in directions that don't
 * affect any residual, and pulls back exactly the directions that do. */
function solveOnce(
  parts: Map<string, ImportedPart>,
  startPoses: Map<string, Pose>,
  freeIds: string[],
  relations: Relation[],
  axisConstraints?: Map<string, AxisConstraint>,
): OnceResult {
  const n = freeIds.length * 6;
  const basePoses = new Map(startPoses);
  const x = new Float64Array(n); // [dPos(3), dRot(3)] per free part, relative to basePoses

  // Rotation locks/limits compare against the Euler-XYZ decomposition of wherever this
  // part started *this whole solve call* — dRot (an exp-map delta) has no per-Euler-axis
  // meaning on its own, unlike dPos, whose components map 1:1 onto world X/Y/Z, so a
  // locked position axis can just penalize its own dPos component directly.
  const rotLockTargetDeg = new Map<string, [number, number, number]>();
  if (axisConstraints) {
    for (const id of freeIds) {
      const constraint = axisConstraints.get(id);
      const needsRot = constraint && (["rx", "ry", "rz"] as const).some((a) => constraint.lock?.[a] || constraint.limits?.[a]);
      if (!needsRot) continue;
      const base = startPoses.get(id);
      if (!base) continue;
      const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...base.quaternion), "XYZ");
      rotLockTargetDeg.set(id, [THREE.MathUtils.radToDeg(e.x), THREE.MathUtils.radToDeg(e.y), THREE.MathUtils.radToDeg(e.z)]);
    }
  }

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
    // Axis locks/limits, as real residuals competing in the same least-squares system as
    // the relations above — see the AxisConstraint doc comment on SolveInput. Every
    // branch below depends only on `axisConstraints` (fixed for this whole solveOnce
    // call) and not on `state` itself, so the number of values pushed per free part is
    // the same on every call — required for the FD Jacobian's J[i][j] indexing above.
    if (axisConstraints) {
      for (let idx = 0; idx < freeIds.length; idx++) {
        const id = freeIds[idx];
        const constraint = axisConstraints.get(id);
        if (!constraint) continue;

        // A locked position axis is enforced as a real hard constraint (see the
        // delta-zeroing in the Newton step loop below) rather than through a residual
        // here — unlike the earlier weighted-penalty version, this guarantees exact
        // zero drift regardless of how hard other relations pull on it, and avoids
        // adding a large-weight residual that would otherwise stiffen (and can
        // ill-condition) the normal equations for every OTHER free part touching this
        // one through a relation. Only limits — which are an elastic boundary, not a
        // fixed value — still need a soft residual.
        const posAxes = ["x", "y", "z"] as const;
        const needsPosLimit = posAxes.some((a) => !constraint.lock?.[a] && constraint.limits?.[a]);
        if (needsPosLimit) {
          const curPos = poseFor(id, state).position;
          for (let i = 0; i < 3; i++) {
            const axis = posAxes[i];
            if (constraint.lock?.[axis]) continue;
            const range = constraint.limits?.[axis];
            if (!range) continue;
            const [min, max] = range;
            const over = Math.max(0, curPos[i] - max);
            const under = Math.max(0, min - curPos[i]);
            out.push((over - under) * AXIS_LIMIT_WEIGHT_POS);
          }
        }

        // A locked rotation axis is also a hard constraint now — see
        // applyRotationLockCorrection below, called after every accepted step — so like
        // position, only a *limit* (an elastic boundary, not a fixed value) still needs
        // a residual here.
        const rotAxes = ["rx", "ry", "rz"] as const;
        const needsRotLimit = rotAxes.some((a) => !constraint.lock?.[a] && constraint.limits?.[a]);
        if (needsRotLimit) {
          const pose = poseFor(id, state);
          const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...pose.quaternion), "XYZ");
          const curDeg = [THREE.MathUtils.radToDeg(e.x), THREE.MathUtils.radToDeg(e.y), THREE.MathUtils.radToDeg(e.z)];
          for (let i = 0; i < 3; i++) {
            const axis = rotAxes[i];
            if (constraint.lock?.[axis]) continue;
            const range = constraint.limits?.[axis];
            if (!range) continue;
            const [min, max] = range;
            const over = Math.max(0, curDeg[i] - max);
            const under = Math.max(0, min - curDeg[i]);
            out.push((over - under) * AXIS_LIMIT_WEIGHT_ROT);
          }
        }
      }
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

        // Hard-lock a position axis: force its share of this step to exactly zero,
        // every iteration — since dPos maps 1:1 onto world X/Y/Z, this is an exact,
        // unambiguous constraint (unlike rotation, whose exp-map delta has no
        // per-Euler-axis correspondence to hold one axis hard the same way). Combined
        // with basePoses re-centering onto xTry after each accepted step, the locked
        // component of basePoses — and so this part's final position on that axis —
        // never moves from where it was when this whole solve began.
        const lock = axisConstraints?.get(freeIds[idx])?.lock;
        if (lock?.x) delta[off] = 0;
        if (lock?.y) delta[off + 1] = 0;
        if (lock?.z) delta[off + 2] = 0;
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
        // map's well-conditioned near-origin region. Also where a locked rotation axis
        // gets snapped back exactly (applyRotationLockCorrection) — since that can
        // change the pose from what `rTry` was measured against, re-evaluate the
        // residual against the now-corrected basePoses (x is freshly zero, so
        // poseFor returns basePoses directly) rather than reusing the stale rTry.
        for (const id of freeIds) {
          const pose = poseFor(id, xTry);
          const corrected = applyRotationLockCorrection(pose, axisConstraints?.get(id), rotLockTargetDeg.get(id));
          basePoses.set(id, corrected);
        }
        x.fill(0);
        r = residuals(x);
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

function randomPerturbedPoses(base: Map<string, Pose>, freeIds: string[], axisConstraints?: Map<string, AxisConstraint>): Map<string, Pose> {
  const out = new Map(base);
  for (const id of freeIds) {
    const pose = base.get(id);
    if (!pose) continue;
    // Never jitter the rotation of a part with any locked rotation axis — solveOnce
    // reads its lock *target* from wherever this pose's Euler-XYZ decomposition already
    // is when it starts (see rotLockTargetDeg), so randomizing it here wouldn't just
    // give this restart a worse starting guess, it would silently move what "locked"
    // means for the entire restart to whatever the random jitter happened to land on.
    const lock = axisConstraints?.get(id)?.lock;
    if (lock?.rx || lock?.ry || lock?.rz) {
      out.set(id, { position: [...pose.position], quaternion: [...pose.quaternion] });
      continue;
    }
    const axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const angle = Math.random() * Math.PI * 2;
    const jitter = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    const quaternion = new THREE.Quaternion(...pose.quaternion).premultiply(jitter);
    out.set(id, { position: [...pose.position], quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] });
  }
  return out;
}

export function solveAssembly(input: SolveInput): SolveResult {
  const { parts, poses, fixedPartIds, relations, axisConstraints } = input;
  // Only parts actually referenced by a relation need to be solver DOF — a free part
  // nothing relates to has no residual pulling on it (an axis lock/limit on it would
  // also start already satisfied, since nothing else ever moves it), so its optimal
  // pose is trivially "stay put." Excluding it keeps the per-iteration FD Jacobian cost
  // (O(m*n) in residuals x free-part DOF) proportional to how much of a large assembly
  // is actually related, not to its total part count — matters once an assembly has
  // many not-yet-related parts (e.g. a bin of loose screws) alongside a smaller
  // constrained subassembly.
  const relatedIds = new Set<string>();
  for (const rel of relations) {
    relatedIds.add(rel.a.partId);
    relatedIds.add(rel.b.partId);
  }
  const freeIds = Array.from(poses.keys()).filter((id) => !fixedPartIds.has(id) && relatedIds.has(id));

  const outPoses = new Map(poses);
  if (freeIds.length === 0 || relations.length === 0) {
    return { poses: outPoses, residualNorm: 0, iterations: 0, converged: true };
  }

  const restarts = input.restarts ?? RESTART_ATTEMPTS;
  let best = solveOnce(parts, poses, freeIds, relations, axisConstraints);
  for (let attempt = 0; attempt < restarts && !best.converged; attempt++) {
    const candidate = solveOnce(parts, randomPerturbedPoses(poses, freeIds, axisConstraints), freeIds, relations, axisConstraints);
    if (candidate.residualNorm < best.residualNorm) best = candidate;
  }
  return best;
}

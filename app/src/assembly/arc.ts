import * as THREE from "three";
import type { Pose, Vec3 } from "../occ/types";

/** A 3-point circular arc, like teaching a C1 (circular) move on a Fanuc: the start and
 * end points come from the segment's two keyframes, and a third "via" point — taught by
 * moving the part there and capturing its current position — pins down which circle the
 * three points actually lie on, and which of its two arcs (the one through `via`, not
 * the complementary one) the part sweeps along. Falls back to null (caller should then
 * fall back to a straight lerp) when the three points are ~collinear, since no finite
 * circle passes through them. */
export interface Arc3Point {
  center: THREE.Vector3;
  radius: number;
  /** Unit vector from center toward the start point — the 0° reference direction. */
  u: THREE.Vector3;
  /** Unit vector 90° from `u` within the arc's own plane, completing a right-handed
   * (u, v, normal) basis — so a point at angle `a` is center + r*(cos(a)*u + sin(a)*v). */
  v: THREE.Vector3;
  /** Signed sweep from the start angle (always 0) to the end angle, in radians — its
   * sign is whichever direction actually passes through the via point, and its
   * magnitude can exceed a semicircle (unlike the *shorter* arc a naive "just pick the
   * short way around" approach would assume) when the via point demands the long way
   * around. */
  sweep: number;
}

const MIN_ARC_RADIUS = 1e-6;

/** Fits the unique circle through three 3D points and returns it as an Arc3Point ready
 * for `arcPointAt`, or null if the points are (numerically) collinear/coincident. */
export function fitArc3Point(start: Vec3, via: Vec3, end: Vec3): Arc3Point | null {
  const p0 = new THREE.Vector3(...start);
  const p1 = new THREE.Vector3(...via);
  const p2 = new THREE.Vector3(...end);

  const e1 = new THREE.Vector3().subVectors(p1, p0);
  const e2 = new THREE.Vector3().subVectors(p2, p0);
  const normal = new THREE.Vector3().crossVectors(e1, e2);
  const normalLenSq = normal.lengthSq();
  if (normalLenSq < 1e-9) return null; // collinear (or two points coincide)
  normal.normalize();

  // Circumcenter of the triangle p0/p1/p2, via the standard barycentric formula —
  // solved in the triangle's own plane (u, v below), then mapped back to world space.
  const u = e1.clone().normalize();
  const v = new THREE.Vector3().crossVectors(normal, u); // already unit: normal, u orthonormal
  const p1x = e1.dot(u); // = |e1|, since u = e1/|e1|
  const p2x = e2.dot(u);
  const p2y = e2.dot(v);
  if (Math.abs(p2y) < 1e-9) return null; // degenerate triangle
  const cx = p1x / 2;
  const cy = (p2x * p2x + p2y * p2y - p2x * p1x) / (2 * p2y);
  const center = p0.clone().addScaledVector(u, cx).addScaledVector(v, cy);
  const radius = center.distanceTo(p0);
  if (!Number.isFinite(radius) || radius < MIN_ARC_RADIUS) return null;

  const startDir = new THREE.Vector3().subVectors(p0, center).normalize();
  const basisV = new THREE.Vector3().crossVectors(normal, startDir); // in-plane, 90° from startDir

  function angleOf(p: THREE.Vector3): number {
    const d = new THREE.Vector3().subVectors(p, center);
    return Math.atan2(d.dot(basisV), d.dot(startDir));
  }
  // Start is always at angle 0 by construction (startDir = (p0-center)/radius). Pick
  // whichever of the two directions around the circle from 0 to end's angle actually
  // passes through via's angle first — normalize both to [0, 2*pi) and compare: if via
  // comes before end going positive, sweep positive; otherwise the positive path skips
  // straight past via, so sweep negative (the "long way" when that's what teaching a
  // via point on the far side of the circle actually means).
  const twoPi = Math.PI * 2;
  const norm = (a: number) => ((a % twoPi) + twoPi) % twoPi;
  const via01 = norm(angleOf(p1));
  const end01 = norm(angleOf(p2));
  const sweep = via01 <= end01 ? end01 : end01 - twoPi;

  return { center, radius, u: startDir, v: basisV, sweep };
}

/** A point on the arc at parameter t (0 = start, 1 = end), sweeping through `via`. */
export function arcPointAt(arc: Arc3Point, t: number): Vec3 {
  const angle = arc.sweep * t;
  const p = arc.center
    .clone()
    .addScaledVector(arc.u, Math.cos(angle) * arc.radius)
    .addScaledVector(arc.v, Math.sin(angle) * arc.radius);
  return [p.x, p.y, p.z];
}

/** Interpolates a full pose between `a` and `b` at parameter t: position follows the
 * 3-point arc through `via` (falling back to a plain lerp if the points are too close
 * to collinear to define one), rotation slerps normally — matching how a taught robot
 * move interpolates its tool orientation independently of the path its TCP travels. */
export function arcLerpPose(a: Pose, via: Vec3, b: Pose, t: number): Pose {
  const arc = fitArc3Point(a.position, via, b.position);
  const position = arc
    ? arcPointAt(arc, t)
    : (() => {
        const p = new THREE.Vector3(...a.position).lerp(new THREE.Vector3(...b.position), t);
        return [p.x, p.y, p.z] as Vec3;
      })();
  const quaternion = new THREE.Quaternion(...a.quaternion).slerp(new THREE.Quaternion(...b.quaternion), t);
  return { position, quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w] };
}

import * as THREE from "three";
import type { EntityRef, ImportedPart, Pose, Quat } from "../occ/types";

export type RelationType = "coincident" | "concentric" | "planar" | "distance" | "parallel" | "rigid";

export interface Relation {
  id: string;
  type: RelationType;
  a: EntityRef;
  b: EntityRef;
  /** Meaning depends on type: planar/distance offset, both in mm. Ignored for concentric/parallel/rigid. */
  value: number;
  /** Only meaningful for "planar": false (default) = faces flush facing each other
   * (normals anti-parallel); true = faces facing the same way (normals parallel). */
  flip?: boolean;
  /** Optional spin-angle limits for "concentric", in degrees, measured from each part's
   * orientation at the moment the relation was created (refQuatA/refQuatB) — like a
   * hinge/revolute joint's travel limits. Both must be set together; either omitted
   * means unlimited. Only meaningful within (-180, 180) — see relationResiduals. */
  angleMin?: number;
  angleMax?: number;
  refQuatA?: Quat;
  refQuatB?: Quat;
  /** Only for "rigid": B's pose relative to A's, captured at the moment the relation was
   * created (B expressed in A's local frame) — enforced going forward however A moves,
   * i.e. "weld B to A" rather than aligning any particular feature. See relationResiduals. */
  rigidOffset?: { position: [number, number, number]; quaternion: Quat };
}

export const RELATION_LABELS: Record<RelationType, string> = {
  coincident: "Coincidente",
  concentric: "Concéntrica",
  planar: "Plana (flush)",
  distance: "Distancia",
  parallel: "Paralela",
  rigid: "Vincular (rígida)",
};

/** One glyph per relation type, for quick visual scanning in the relation-type picker
 * and the relations list — chosen to echo the constraint's geometry rather than being
 * arbitrary: concentric's bullseye is literally concentric circles, parallel is the
 * math symbol for it, distance is a between-two-points arrow, planar's triple bar reads
 * as flush stacked faces, and rigid's link/coincident's target follow the app's existing
 * emoji-icon style (🔒/📷/✂/👁 elsewhere in the UI). */
export const RELATION_ICONS: Record<RelationType, string> = {
  coincident: "🎯",
  concentric: "◎",
  planar: "≣",
  distance: "↔",
  parallel: "∥",
  rigid: "🔗",
};

export interface ResolvedEntity {
  /** A representative point (axis origin for cylindrical, centroid-ish point for planar, midpoint/center for edges). */
  point: THREE.Vector3;
  /** Outward normal (planar face) or axis direction (cylinder/cone/circle/line), unit length. */
  direction: THREE.Vector3;
  radius?: number;
  isAxis: boolean; // true for cylinder/cone/circle (axis-like), false for plane/point-like (line uses direction too but point-like ends)
  /** The owning part's full orientation — only used for "concentric" angle limits, which
   * need the part's whole rotation (a cylindrical face alone has no rotational reference
   * about its own axis to measure "how far it's spun" from). */
  quaternion: THREE.Quaternion;
}

function poseMatrix(pose: Pose): THREE.Matrix4 {
  const m = new THREE.Matrix4();
  m.compose(
    new THREE.Vector3(...pose.position),
    new THREE.Quaternion(...pose.quaternion),
    new THREE.Vector3(1, 1, 1),
  );
  return m;
}

export function resolveEntity(part: ImportedPart, ref: EntityRef, pose: Pose): ResolvedEntity | null {
  const m = poseMatrix(pose);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(m);
  const quaternion = new THREE.Quaternion(...pose.quaternion);

  if (ref.kind === "part") {
    // The whole part's own origin/orientation — no feature lookup needed, so this
    // resolves even for a part with no faces/edges at all (e.g. a camera object).
    const point = new THREE.Vector3(0, 0, 0).applyMatrix4(m);
    const direction = new THREE.Vector3(0, 0, 1).applyMatrix3(normalMatrix).normalize();
    return { point, direction, isAxis: false, quaternion };
  }

  if (ref.kind === "face") {
    const face = part.mesh.faces.find((f) => f.id === ref.id);
    if (!face) return null;
    const isAxis = face.kind === "cylinder" || face.kind === "cone" || face.kind === "torus";
    const basePoint = isAxis && face.axisOrigin ? face.axisOrigin : face.point;
    const point = new THREE.Vector3(...basePoint).applyMatrix4(m);
    const direction = new THREE.Vector3(...face.normal).applyMatrix3(normalMatrix).normalize();
    return { point, direction, radius: face.radius, isAxis, quaternion };
  }

  const edge = part.mesh.edges.find((e) => e.id === ref.id);
  if (!edge) return null;
  const isAxis = edge.kind === "circle";
  const basePoint = isAxis && edge.axisOrigin ? edge.axisOrigin : edge.point;
  const point = new THREE.Vector3(...basePoint).applyMatrix4(m);
  const direction = new THREE.Vector3(...edge.direction).applyMatrix3(normalMatrix).normalize();
  return { point, direction, radius: edge.radius, isAxis, quaternion };
}

/** Which relation types make geometric sense for the two picked entity kinds — used to
 * enable/disable the relation buttons in the UI. */
export function applicableRelationTypes(a: ResolvedEntity, b: ResolvedEntity): RelationType[] {
  const types: RelationType[] = ["distance", "parallel"];
  if (a.isAxis && b.isAxis) types.unshift("concentric");
  if (!a.isAxis && !b.isAxis) {
    types.unshift("coincident", "planar");
  }
  return types;
}

const ANGLE_LIMIT_WEIGHT = 0.03;

/** How far B has spun relative to A about their shared concentric axis, beyond
 * wherever they were when the limit was set (refQuatA/refQuatB) — like reading a
 * hinge's current angle. Predicts where B "should" be if it had rigidly followed A's
 * own motion since then (qB0 turned by the same world-frame delta A itself underwent),
 * and measures the leftover rotation against that prediction, projected onto the
 * current shared axis (a swing-twist "twist" extraction). A one-sided hinge-limit
 * penalty (zero inside [angleMin, angleMax], growing linearly outside it) turns that
 * into a residual the solver treats like any other constraint. */
function concentricAngleLimitResidual(relation: Relation, a: ResolvedEntity, b: ResolvedEntity): number {
  const qA0 = new THREE.Quaternion(...relation.refQuatA!);
  const qB0 = new THREE.Quaternion(...relation.refQuatB!);
  const dqA = a.quaternion.clone().multiply(qA0.clone().invert());
  const predictedB = dqA.multiply(qB0);
  const spin = b.quaternion.clone().multiply(predictedB.invert());
  const axis = a.direction;
  const twist = spin.x * axis.x + spin.y * axis.y + spin.z * axis.z;
  const angleDeg = 2 * Math.atan2(twist, spin.w) * (180 / Math.PI);
  const over = Math.max(0, angleDeg - relation.angleMax!);
  const under = Math.max(0, relation.angleMin! - angleDeg);
  return (over - under) * ANGLE_LIMIT_WEIGHT;
}

/** Returns a flat vector of scalar residuals that a solved assembly should drive to zero. */
export function relationResiduals(
  relation: Relation,
  a: ResolvedEntity,
  b: ResolvedEntity,
): number[] {
  switch (relation.type) {
    case "coincident": {
      const d = new THREE.Vector3().subVectors(a.point, b.point);
      return [d.x, d.y, d.z];
    }
    case "parallel": {
      const cross = new THREE.Vector3().crossVectors(a.direction, b.direction);
      return [cross.x, cross.y, cross.z];
    }
    case "planar": {
      // Faces flush: normals anti-parallel by default (facing each other), or parallel
      // (facing the same way) when flipped. Plane offset along a's normal = value.
      const bDir = relation.flip ? b.direction.clone().negate() : b.direction;
      const sum = new THREE.Vector3().addVectors(a.direction, bDir);
      const offset = new THREE.Vector3().subVectors(b.point, a.point).dot(a.direction) - relation.value;
      return [sum.x, sum.y, sum.z, offset];
    }
    case "concentric": {
      // Axis directions parallel...
      const cross = new THREE.Vector3().crossVectors(a.direction, b.direction);
      // ...and the axis lines coincide: perpendicular component of the point offset must vanish.
      const delta = new THREE.Vector3().subVectors(b.point, a.point);
      const along = a.direction.clone().multiplyScalar(delta.dot(a.direction));
      const perp = delta.clone().sub(along);
      const out = [cross.x, cross.y, cross.z, perp.x, perp.y, perp.z];
      if (relation.angleMin !== undefined && relation.angleMax !== undefined && relation.refQuatA && relation.refQuatB) {
        out.push(concentricAngleLimitResidual(relation, a, b));
      }
      return out;
    }
    case "distance": {
      const dist = a.point.distanceTo(b.point) - relation.value;
      return [dist];
    }
    case "rigid": {
      // Weld B to A: B should sit exactly `rigidOffset` away from A, in A's own local
      // frame, however A itself has moved — i.e. B rigidly follows A's translation
      // *and* rotation, like they were the same object. Position residual is the
      // straightforward offset mismatch; orientation residual is the (small-angle-
      // linearized) imaginary part of the mismatch quaternion, the same trick the exp-map
      // step parametrization elsewhere in the solver relies on — it's a valid local
      // model near zero, which is all Gauss-Newton needs, and it's exactly zero only
      // when the two orientations truly match.
      const offset = relation.rigidOffset!;
      const predictedPos = new THREE.Vector3(...offset.position).applyQuaternion(a.quaternion).add(a.point);
      const posResidual = new THREE.Vector3().subVectors(b.point, predictedPos);
      const offsetQuat = new THREE.Quaternion(...offset.quaternion);
      const predictedQuat = a.quaternion.clone().multiply(offsetQuat);
      const mismatch = b.quaternion.clone().multiply(predictedQuat.clone().invert());
      return [posResidual.x, posResidual.y, posResidual.z, 2 * mismatch.x, 2 * mismatch.y, 2 * mismatch.z];
    }
  }
}

import * as THREE from "three";
import type { EntityRef, ImportedPart, Pose } from "../occ/types";

export type RelationType = "coincident" | "concentric" | "planar" | "distance" | "parallel";

export interface Relation {
  id: string;
  type: RelationType;
  a: EntityRef;
  b: EntityRef;
  /** Meaning depends on type: planar/distance offset, both in mm. Ignored for concentric/parallel. */
  value: number;
  /** Only meaningful for "planar": false (default) = faces flush facing each other
   * (normals anti-parallel); true = faces facing the same way (normals parallel). */
  flip?: boolean;
}

export const RELATION_LABELS: Record<RelationType, string> = {
  coincident: "Coincidente",
  concentric: "Concéntrica",
  planar: "Plana (flush)",
  distance: "Distancia",
  parallel: "Paralela",
};

export interface ResolvedEntity {
  /** A representative point (axis origin for cylindrical, centroid-ish point for planar, midpoint/center for edges). */
  point: THREE.Vector3;
  /** Outward normal (planar face) or axis direction (cylinder/cone/circle/line), unit length. */
  direction: THREE.Vector3;
  radius?: number;
  isAxis: boolean; // true for cylinder/cone/circle (axis-like), false for plane/point-like (line uses direction too but point-like ends)
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

  if (ref.kind === "face") {
    const face = part.mesh.faces.find((f) => f.id === ref.id);
    if (!face) return null;
    const isAxis = face.kind === "cylinder" || face.kind === "cone" || face.kind === "torus";
    const basePoint = isAxis && face.axisOrigin ? face.axisOrigin : face.point;
    const point = new THREE.Vector3(...basePoint).applyMatrix4(m);
    const direction = new THREE.Vector3(...face.normal).applyMatrix3(normalMatrix).normalize();
    return { point, direction, radius: face.radius, isAxis };
  }

  const edge = part.mesh.edges.find((e) => e.id === ref.id);
  if (!edge) return null;
  const isAxis = edge.kind === "circle";
  const basePoint = isAxis && edge.axisOrigin ? edge.axisOrigin : edge.point;
  const point = new THREE.Vector3(...basePoint).applyMatrix4(m);
  const direction = new THREE.Vector3(...edge.direction).applyMatrix3(normalMatrix).normalize();
  return { point, direction, radius: edge.radius, isAxis };
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
      return [cross.x, cross.y, cross.z, perp.x, perp.y, perp.z];
    }
    case "distance": {
      const dist = a.point.distanceTo(b.point) - relation.value;
      return [dist];
    }
  }
}

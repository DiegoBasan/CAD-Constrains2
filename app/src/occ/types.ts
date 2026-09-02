// Domain-level (not OCCT-level) types shared across the app.

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

export interface Pose {
  position: Vec3;
  quaternion: Quat;
}

export function identityPose(): Pose {
  return { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };
}

/** A triangulated mesh for one imported solid, ready for a three.js BufferGeometry. */
export interface PartMesh {
  positions: Float32Array; // xyz per vertex, in the part's local (as-imported) frame
  normals: Float32Array;
  indices: Uint32Array;
  /** indices.length/3 entries: which OCCT face (index into `faces`) each triangle belongs to. */
  triangleFaceId: Int32Array;
  faces: FaceInfo[];
  edges: EdgeInfo[];
}

export type SurfaceKind = "plane" | "cylinder" | "cone" | "sphere" | "torus" | "other";

export interface FaceInfo {
  id: number;
  kind: SurfaceKind;
  /** A point on the surface, in the part's local frame. */
  point: Vec3;
  /** Outward normal at `point` (plane), or the axis direction (cylinder/cone/torus). */
  normal: Vec3;
  /** Axis origin, for cylinder/cone/torus. */
  axisOrigin?: Vec3;
  radius?: number;
  area: number;
}

export type CurveKind = "line" | "circle" | "other";

export interface EdgeInfo {
  id: number;
  kind: CurveKind;
  /** Midpoint, in the part's local frame. */
  point: Vec3;
  /** Line direction, or circle axis direction. */
  direction: Vec3;
  axisOrigin?: Vec3; // circle center
  radius?: number;
  a: Vec3; // start vertex
  b: Vec3; // end vertex
  /** The edge's actual shape as a render-ready polyline (>=2 points) — for a "line"
   * this is just [a, b], but a curved edge (circle/arc, or any other curve type) is
   * sampled at several points along its true path so it's drawn as a curve rather than
   * the single straight chord `a`-to-`b` would otherwise imply. */
  polyline: Vec3[];
}

export interface ImportedPart {
  id: string;
  name: string;
  mesh: PartMesh;
  /** The transform this part carried in the source STEP assembly (used as the initial pose). */
  initialPose: Pose;
}

export interface ImportedAssembly {
  fileName: string;
  parts: ImportedPart[];
}

/** What the user has clicked on in the viewport. "part" refers to the whole object (its
 * own origin/orientation) rather than one of its faces/edges — used by the "rigid"
 * relation, which welds two parts' poses together instead of aligning a picked feature;
 * `id` is unused (0) for that kind. */
export interface EntityRef {
  partId: string;
  kind: "face" | "edge" | "part";
  id: number; // FaceInfo.id or EdgeInfo.id; unused for kind "part"
}

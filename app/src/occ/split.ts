import { recenterPartMesh } from "./tessellate";
import type { FaceInfo, PartMesh, Vec3 } from "./types";

class UnionFind {
  private parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

const WELD_EPSILON = 1e-4; // mm — merges the duplicate vertices that adjacent faces leave at shared edges

/** Groups the mesh's triangles into connected components (vertices shared between
 * triangles link them into the same body). STEP files translate each disjoint solid
 * of a multi-body part into geometry that shares no vertices with the others, so this
 * reliably separates "one part made of several unconnected bodies" from "one part
 * that's genuinely a single connected shape".
 *
 * Each face was tessellated independently (see tessellate.ts), so two faces of the
 * very same solid don't actually share vertex *indices* along their common edge —
 * they just have coincident *positions* there. We weld same-position vertices
 * together first so connectivity is judged on the real geometry, not on the mesh's
 * per-face vertex layout. */
function connectedTriangleGroups(mesh: PartMesh): number[][] {
  const vertexCount = mesh.positions.length / 3;
  const uf = new UnionFind(vertexCount);

  const grid = new Map<string, number>();
  const cell = (v: number) => Math.round(v / WELD_EPSILON);
  for (let i = 0; i < vertexCount; i++) {
    const x = mesh.positions[i * 3];
    const y = mesh.positions[i * 3 + 1];
    const z = mesh.positions[i * 3 + 2];
    const key = `${cell(x)},${cell(y)},${cell(z)}`;
    const existing = grid.get(key);
    if (existing === undefined) grid.set(key, i);
    else uf.union(existing, i);
  }

  const triCount = mesh.indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    const a = mesh.indices[t * 3];
    const b = mesh.indices[t * 3 + 1];
    const c = mesh.indices[t * 3 + 2];
    uf.union(a, b);
    uf.union(b, c);
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const root = uf.find(mesh.indices[t * 3]);
    let list = groups.get(root);
    if (!list) {
      list = [];
      groups.set(root, list);
    }
    list.push(t);
  }
  return Array.from(groups.values());
}

export function countConnectedBodies(mesh: PartMesh): number {
  if (mesh.indices.length === 0) return 1;
  return connectedTriangleGroups(mesh).length;
}

function boxOf(positions: Float32Array, indices: Uint32Array, triIndices: number[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const t of triIndices) {
    for (let k = 0; k < 3; k++) {
      const v = indices[t * 3 + k];
      for (let a = 0; a < 3; a++) {
        const val = positions[v * 3 + a];
        if (val < min[a]) min[a] = val;
        if (val > max[a]) max[a] = val;
      }
    }
  }
  return { min, max };
}

function distanceToBox(p: Vec3, box: { min: Vec3; max: Vec3 }): number {
  let d2 = 0;
  for (let a = 0; a < 3; a++) {
    const v = p[a];
    if (v < box.min[a]) d2 += (box.min[a] - v) ** 2;
    else if (v > box.max[a]) d2 += (v - box.max[a]) ** 2;
  }
  return d2;
}

/** Splits a multi-body part's mesh into one PartMesh per connected body, each
 * re-centered around its own bounding-box middle. Returns null if the mesh is a
 * single connected body (nothing to split). */
export function splitPartMesh(mesh: PartMesh): { mesh: PartMesh; origin: Vec3 }[] | null {
  const groups = connectedTriangleGroups(mesh);
  if (groups.length <= 1) return null;

  const boxes = groups.map((tris) => boxOf(mesh.positions, mesh.indices, tris));

  const subMeshes: PartMesh[] = groups.map((triIndices) => {
    const oldToNew = new Map<number, number>();
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const triangleFaceId: number[] = [];
    const faceIds = new Set<number>();

    for (const t of triIndices) {
      for (let k = 0; k < 3; k++) {
        const v = mesh.indices[t * 3 + k];
        let newIndex = oldToNew.get(v);
        if (newIndex === undefined) {
          newIndex = positions.length / 3;
          oldToNew.set(v, newIndex);
          positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
          normals.push(mesh.normals[v * 3], mesh.normals[v * 3 + 1], mesh.normals[v * 3 + 2]);
        }
        indices.push(newIndex);
      }
      const faceId = mesh.triangleFaceId[t];
      triangleFaceId.push(faceId);
      faceIds.add(faceId);
    }

    const faces: FaceInfo[] = mesh.faces.filter((f) => faceIds.has(f.id));
    return {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
      triangleFaceId: new Int32Array(triangleFaceId),
      faces,
      edges: [],
    };
  });

  // Assign each edge to whichever body's box contains (or is nearest) its midpoint —
  // edges aren't tessellated triangles, so they need a geometric assignment instead.
  for (const edge of mesh.edges) {
    let bestIndex = 0;
    let bestDist = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      const d = distanceToBox(edge.point, boxes[i]);
      if (d < bestDist) {
        bestDist = d;
        bestIndex = i;
      }
    }
    subMeshes[bestIndex].edges.push(edge);
  }

  return subMeshes.map((m) => recenterPartMesh(m));
}

import type { OpenCascadeInstance } from "./init";
import type { EdgeInfo, FaceInfo, PartMesh, SurfaceKind, CurveKind, Vec3 } from "./types";

const MESH_LINEAR_DEFLECTION = 0.15;
const MESH_ANGULAR_DEFLECTION = 0.4;

function surfaceKind(oc: OpenCascadeInstance, typeValue: number): SurfaceKind {
  const t = oc.GeomAbs_SurfaceType;
  if (typeValue === t.GeomAbs_Plane.value) return "plane";
  if (typeValue === t.GeomAbs_Cylinder.value) return "cylinder";
  if (typeValue === t.GeomAbs_Cone.value) return "cone";
  if (typeValue === t.GeomAbs_Sphere.value) return "sphere";
  if (typeValue === t.GeomAbs_Torus.value) return "torus";
  return "other";
}

function curveKind(oc: OpenCascadeInstance, typeValue: number): CurveKind {
  const t = oc.GeomAbs_CurveType;
  if (typeValue === t.GeomAbs_Line.value) return "line";
  if (typeValue === t.GeomAbs_Circle.value) return "circle";
  return "other";
}

/** Runs BRepMesh on `shape` (in place) then walks its faces to build a render-ready mesh
 * plus analytic face/edge info used for picking and assembly relations. `shape` must
 * already be in the part's own local frame (see stepImport.ts for how parts are split out
 * of the STEP assembly and stripped of their placement). */
export function tessellateShape(oc: OpenCascadeInstance, shape: OpenCascadeInstance): PartMesh {
  new oc.BRepMesh_IncrementalMesh_2(shape, MESH_LINEAR_DEFLECTION, false, MESH_ANGULAR_DEFLECTION, true);

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const triangleFaceId: number[] = [];
  const faces: FaceInfo[] = [];

  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE;
  const SHAPE = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
  const REVERSED = oc.TopAbs_Orientation.TopAbs_REVERSED.value;

  let faceId = 0;
  for (
    const exp = new oc.TopExp_Explorer_2(shape, FACE, SHAPE);
    exp.More();
    exp.Next()
  ) {
    const face = oc.TopoDS.Face_1(exp.Current());
    const location = new oc.TopLoc_Location_1();
    const triHandle = oc.BRep_Tool.Triangulation(face, location);
    if (triHandle.IsNull()) continue;
    const tri = triHandle.get();

    const nbNodes = tri.NbNodes();
    const nbTriangles = tri.NbTriangles();
    if (nbNodes === 0 || nbTriangles === 0) continue;

    const trsf = location.Transformation();
    const baseIndex = positions.length / 3;

    const localPts: Vec3[] = new Array(nbNodes);
    const accumNormal: [number, number, number][] = new Array(nbNodes);
    for (let i = 1; i <= nbNodes; i++) {
      const p = tri.Node(i).Transformed(trsf);
      localPts[i - 1] = [p.X(), p.Y(), p.Z()];
      accumNormal[i - 1] = [0, 0, 0];
      positions.push(p.X(), p.Y(), p.Z());
    }

    const reversed = face.Orientation_1().value === REVERSED;
    const localTris: [number, number, number][] = new Array(nbTriangles);
    for (let i = 1; i <= nbTriangles; i++) {
      const t = tri.Triangle(i);
      let a = t.Value(1) - 1;
      let b = t.Value(2) - 1;
      let c = t.Value(3) - 1;
      if (reversed) {
        const tmp = b;
        b = c;
        c = tmp;
      }
      localTris[i - 1] = [a, b, c];

      const pa = localPts[a];
      const pb = localPts[b];
      const pc = localPts[c];
      const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
      const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      for (const idx of [a, b, c]) {
        accumNormal[idx][0] += nx;
        accumNormal[idx][1] += ny;
        accumNormal[idx][2] += nz;
      }

      indices.push(baseIndex + a, baseIndex + b, baseIndex + c);
      triangleFaceId.push(faceId);
    }

    for (let i = 0; i < nbNodes; i++) {
      const [nx, ny, nz] = accumNormal[i];
      const len = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / len, ny / len, nz / len);
    }

    let kind: SurfaceKind = "other";
    let point: Vec3 = [0, 0, 0];
    let normal: Vec3 = [0, 0, 1];
    let axisOrigin: Vec3 | undefined;
    let radius: number | undefined;
    try {
      const adaptor = new oc.BRepAdaptor_Surface_2(face, true);
      const typeVal = adaptor.GetType().value;
      kind = surfaceKind(oc, typeVal);
      if (kind === "plane") {
        const pln = adaptor.Plane();
        const ax = pln.Axis();
        const dir = ax.Direction();
        const loc = ax.Location();
        normal = [dir.X(), dir.Y(), dir.Z()];
        point = [loc.X(), loc.Y(), loc.Z()];
      } else if (kind === "cylinder") {
        const cyl = adaptor.Cylinder();
        const ax = cyl.Axis();
        const dir = ax.Direction();
        const loc = ax.Location();
        normal = [dir.X(), dir.Y(), dir.Z()];
        point = [loc.X(), loc.Y(), loc.Z()];
        axisOrigin = point;
        radius = cyl.Radius();
      } else if (kind === "cone") {
        const cone = adaptor.Cone();
        const ax = cone.Axis();
        const dir = ax.Direction();
        const loc = ax.Location();
        normal = [dir.X(), dir.Y(), dir.Z()];
        point = [loc.X(), loc.Y(), loc.Z()];
        axisOrigin = point;
      } else if (kind === "sphere") {
        const sph = adaptor.Sphere();
        const loc = sph.Location();
        point = [loc.X(), loc.Y(), loc.Z()];
        radius = sph.Radius();
      } else if (kind === "torus") {
        const tor = adaptor.Torus();
        const ax = tor.Axis();
        const dir = ax.Direction();
        const loc = ax.Location();
        normal = [dir.X(), dir.Y(), dir.Z()];
        point = [loc.X(), loc.Y(), loc.Z()];
        axisOrigin = point;
      } else {
        point = localPts[0];
        normal = [accumNormal[0][0], accumNormal[0][1], accumNormal[0][2]];
        const len = Math.hypot(...normal) || 1;
        normal = [normal[0] / len, normal[1] / len, normal[2] / len];
      }
    } catch {
      point = localPts[0];
    }

    let area = 0;
    try {
      const gprops = new oc.GProp_GProps_1();
      oc.BRepGProp.SurfaceProperties_1(face, gprops, false, false);
      area = gprops.Mass();
    } catch {
      area = 0;
    }

    faces.push({ id: faceId, kind, point, normal, axisOrigin, radius, area });
    faceId++;
  }

  const edges = extractEdges(oc, shape);

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    triangleFaceId: new Int32Array(triangleFaceId),
    faces,
    edges,
  };
}

// A sample roughly every 4 degrees of arc keeps circles/arcs looking smooth (a full
// circle gets 90 segments) without over-sampling short arcs or fillets.
const CURVE_SAMPLE_STEP_RAD = (4 * Math.PI) / 180;
const CURVE_MIN_SAMPLES = 8;
const CURVE_MAX_SAMPLES = 180;

function extractEdges(oc: OpenCascadeInstance, shape: OpenCascadeInstance): EdgeInfo[] {
  const edges: EdgeInfo[] = [];
  const EDGE = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
  const SHAPE = oc.TopAbs_ShapeEnum.TopAbs_SHAPE;
  let id = 0;
  for (
    const exp = new oc.TopExp_Explorer_2(shape, EDGE, SHAPE);
    exp.More();
    exp.Next()
  ) {
    try {
      const edge = oc.TopoDS.Edge_1(exp.Current());
      const adaptor = new oc.BRepAdaptor_Curve_2(edge);
      const typeVal = adaptor.GetType().value;
      const kind = curveKind(oc, typeVal);
      const u0 = adaptor.FirstParameter();
      const u1 = adaptor.LastParameter();
      const pa = adaptor.Value(u0);
      const pb = adaptor.Value(u1);
      const mid = adaptor.Value((u0 + u1) / 2);

      let direction: Vec3 = [pb.X() - pa.X(), pb.Y() - pa.Y(), pb.Z() - pa.Z()];
      let axisOrigin: Vec3 | undefined;
      let radius: number | undefined;
      if (kind === "line") {
        const lin = adaptor.Line();
        const dir = lin.Direction();
        direction = [dir.X(), dir.Y(), dir.Z()];
      } else if (kind === "circle") {
        const circ = adaptor.Circle();
        const ax = circ.Axis();
        const dir = ax.Direction();
        const loc = ax.Location();
        direction = [dir.X(), dir.Y(), dir.Z()];
        axisOrigin = [loc.X(), loc.Y(), loc.Z()];
        radius = circ.Radius();
      }
      const len = Math.hypot(...direction) || 1;
      direction = [direction[0] / len, direction[1] / len, direction[2] / len];

      // A "line" is exactly its two endpoints; any other curve type (circle, ellipse,
      // b-spline, ...) is sampled along its true path — rendering it as the single
      // start-to-end chord (as if it were a line) is what made curved edges look wrong,
      // especially full or near-full circles where that chord can cut right across the
      // circle instead of tracing its rim.
      let polyline: Vec3[];
      if (kind === "line") {
        polyline = [[pa.X(), pa.Y(), pa.Z()], [pb.X(), pb.Y(), pb.Z()]];
      } else {
        const span = Math.abs(u1 - u0);
        const samples = Math.max(
          CURVE_MIN_SAMPLES,
          Math.min(CURVE_MAX_SAMPLES, Math.ceil(span / CURVE_SAMPLE_STEP_RAD)),
        );
        polyline = new Array(samples + 1);
        for (let i = 0; i <= samples; i++) {
          const u = u0 + (span === 0 ? 0 : ((u1 - u0) * i) / samples);
          const p = adaptor.Value(u);
          polyline[i] = [p.X(), p.Y(), p.Z()];
        }
      }

      edges.push({
        id: id++,
        kind,
        point: [mid.X(), mid.Y(), mid.Z()],
        direction,
        axisOrigin,
        radius,
        a: [pa.X(), pa.Y(), pa.Z()],
        b: [pb.X(), pb.Y(), pb.Z()],
        polyline,
      });
    } catch {
      // Skip edges whose curve type isn't handled (splines etc.) — not needed for mates.
    }
  }
  return edges;
}

/** Re-expresses a mesh (built in whatever "as imported" frame tessellateShape produced —
 * absolute file coordinates, since we tessellate each part with its full placement baked
 * in) around its own bounding-box center. This gives every part a sensible local origin
 * to rotate/drag around and to attach the move gizmo to, regardless of whether the source
 * STEP file encoded the part's placement via a proper assembly TopLoc_Location or simply
 * baked it into the raw B-rep coordinates (both are common in the wild). Returns the new
 * mesh plus the world-space point that origin corresponds to. */
export function recenterPartMesh(mesh: PartMesh): { mesh: PartMesh; origin: Vec3 } {
  const { positions } = mesh;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  const origin: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];

  const shiftedPositions = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    shiftedPositions[i] = positions[i] - origin[0];
    shiftedPositions[i + 1] = positions[i + 1] - origin[1];
    shiftedPositions[i + 2] = positions[i + 2] - origin[2];
  }

  const shiftPoint = (p: Vec3): Vec3 => [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]];

  const faces = mesh.faces.map((f) => ({
    ...f,
    point: shiftPoint(f.point),
    axisOrigin: f.axisOrigin ? shiftPoint(f.axisOrigin) : undefined,
  }));
  const edges = mesh.edges.map((e) => ({
    ...e,
    point: shiftPoint(e.point),
    axisOrigin: e.axisOrigin ? shiftPoint(e.axisOrigin) : undefined,
    a: shiftPoint(e.a),
    b: shiftPoint(e.b),
    polyline: e.polyline.map(shiftPoint),
  }));

  return {
    mesh: { ...mesh, positions: shiftedPositions, faces, edges },
    origin,
  };
}

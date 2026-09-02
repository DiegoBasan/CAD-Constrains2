import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useAssemblyStore, type CameraProjection, type PartState, type RotatePivotMode, type ViewPreset } from "../assembly/store";
import type { ImportedPart } from "../occ/types";
import { EDGE_COLOR, EDGE_HIGHLIGHT_COLOR, PICK_COLOR, SELECTED_PART_COLOR, UNIFORM_GRAY_COLOR, partColor } from "./colors";
import { applyViewPreset } from "./viewPresets";

type SceneCamera = THREE.OrthographicCamera | THREE.PerspectiveCamera;

/** How far the camera needs to sit from `target` to frame a sphere of `radius` —
 * for orthographic the visible extent comes from left/right/top/bottom instead, so
 * distance only needs to keep the content between the near/far clip planes; for
 * perspective, distance is what actually controls the framing. */
function fitDistance(camera: SceneCamera, radius: number): number {
  if (camera instanceof THREE.PerspectiveCamera) {
    return radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  }
  return radius * 3;
}

/** Sizes the camera's frustum to frame a sphere of `radius` at the given aspect ratio —
 * for orthographic this is the actual left/right/top/bottom; for perspective the FOV
 * stays fixed and framing instead comes entirely from the camera's distance (see
 * fitDistance), so this only needs to keep the aspect ratio in sync here. */
function fitCameraFrustum(camera: SceneCamera, radius: number, aspect: number, resetZoom = true): void {
  if (camera instanceof THREE.OrthographicCamera) {
    camera.top = radius;
    camera.bottom = -radius;
    camera.left = -radius * aspect;
    camera.right = radius * aspect;
  } else {
    camera.aspect = aspect;
  }
  if (resetZoom) camera.zoom = 1;
  camera.updateProjectionMatrix();
}

interface PartVisual {
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
  baseColor: number;
  edgeLines: THREE.LineSegments;
  /** Which entry of `part.mesh.edges` each rendered line segment belongs to — a curved
   * edge is drawn as several segments (see EdgeInfo.polyline), so this isn't a plain
   * 1:1 index like it would be for straight-only edges. */
  edgeSegmentIndex: Int32Array;
  highlightMesh: THREE.Mesh | null;
  /** True for a camera object's visual — `mesh` is an invisible pickable proxy (a
   * camera has no real solid geometry) and `edgeLines` is its frustum gizmo, not real
   * part edges, so several places (edge-picking, body-color reconciliation) need to
   * treat it differently from a normal part's visual. */
  isCamera?: boolean;
  /** The PartState object the reconcile effect last applied to this visual — see its
   * use below: applyPosesToParts (store.ts) preserves a part's PartState object
   * identity whenever a solve leaves its pose untouched, so comparing against this by
   * reference (not value) is a cheap, correct way to tell "did anything about this
   * specific part actually change" without diffing pose/color/etc. by hand — matters
   * for a large assembly where most parts sit still on any given keyframe-playback
   * frame while only a few actually move. */
  lastReconciledState?: PartState;
}

const CAMERA_GIZMO_COLOR = 0xffcc55;
const CAMERA_GIZMO_SELECTED_COLOR = 0x4fa3ff;
const CAMERA_GIZMO_DEPTH = 22; // mm — how far the frustum's base sits from the apex
const CAMERA_GIZMO_HALF_W = 13;
const CAMERA_GIZMO_HALF_H = 9;
const CAMERA_PROXY_RADIUS = 10; // invisible pickable sphere, so the gizmo is easy to click

// POV picture-in-picture widget size/position (bottom-right corner) — kept in sync with
// the matching CSS overlay div in the component's JSX.
const PIP_W = 260;
const PIP_H = 180;
const PIP_MARGIN = 12;

/** A camera object's visual: no solid mesh (it has none), just an invisible pickable
 * proxy sphere (so clicking/dragging works like any other part) plus a wireframe
 * frustum gizmo — apex at the camera's own origin, base square along local -Z (the
 * same "forward" convention three.js's own cameras use), matching the little pyramid
 * icon Blender and similar tools draw for a camera object. */
function buildCameraVisual(partId: string): PartVisual {
  const group = new THREE.Group();
  group.name = partId;

  const proxyGeometry = new THREE.SphereGeometry(CAMERA_PROXY_RADIUS, 8, 6);
  const proxyMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const mesh = new THREE.Mesh(proxyGeometry, proxyMaterial);
  mesh.userData.partId = partId;
  group.add(mesh);

  const z = -CAMERA_GIZMO_DEPTH;
  const corners: [number, number, number][] = [
    [-CAMERA_GIZMO_HALF_W, -CAMERA_GIZMO_HALF_H, z],
    [CAMERA_GIZMO_HALF_W, -CAMERA_GIZMO_HALF_H, z],
    [CAMERA_GIZMO_HALF_W, CAMERA_GIZMO_HALF_H, z],
    [-CAMERA_GIZMO_HALF_W, CAMERA_GIZMO_HALF_H, z],
  ];
  const apex: [number, number, number] = [0, 0, 0];
  const segments: [number, number, number][] = [];
  for (const c of corners) segments.push(apex, c);
  for (let i = 0; i < 4; i++) segments.push(corners[i], corners[(i + 1) % 4]);
  const positions = new Float32Array(segments.length * 3);
  segments.forEach((p, i) => positions.set(p, i * 3));
  const gizmoGeometry = new THREE.BufferGeometry();
  gizmoGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const gizmoMaterial = new THREE.LineBasicMaterial({ color: CAMERA_GIZMO_COLOR });
  const edgeLines = new THREE.LineSegments(gizmoGeometry, gizmoMaterial);
  edgeLines.userData.partId = partId;
  group.add(edgeLines);

  return {
    group,
    mesh,
    material: proxyMaterial,
    baseColor: CAMERA_GIZMO_COLOR,
    edgeLines,
    edgeSegmentIndex: new Int32Array(0),
    highlightMesh: null,
    isCamera: true,
  };
}

/** Which single world axis a translate drag is currently magnetized to, while Shift is
 * held (Blender-style) — `null` means free movement. Picked once when Shift starts
 * being held during the drag (whichever axis the raw drag delta at that moment leans
 * toward most), and re-picked the next time Shift comes back down after being released
 * mid-drag; live (re-checked every frame), so releasing Shift always returns to free
 * movement immediately. */
type SnapAxis = "x" | "y" | "z" | null;

/** An in-progress direct-manipulation drag on the selected part's body — free (not
 * axis-constrained) translate in the camera's view plane, or one of three rotate
 * pivots (see RotatePivotMode). Armed on pointerdown over the part; only becomes an
 * actual drag once the pointer moves past the click threshold, so a plain tap still
 * falls through to face/edge picking. Every frame's target seeds the solver's starting
 * guess for the dragged part (store.applyDragPreview) instead of its last-solved pose,
 * so the part tracks the cursor exactly where relations leave it free, and is pulled
 * back only along whatever they actually constrain — in real time, not just on release. */
type ArmedDrag =
  | { kind: "translate"; partId: string; dragging: boolean; plane: THREE.Plane; startPoint: THREE.Vector3; startPosition: THREE.Vector3; snapAxis: SnapAxis }
  | { kind: "rotate"; partId: string; dragging: boolean; pivotMode: RotatePivotMode; lastScreen: THREE.Vector2 }
  // Dragging a selected group, or an ad-hoc multi-selection: translate-only (see
  // store.applyGroupDragPreview) — every member is offset by the same rigid delta from
  // its own start position, and each one still resists independently wherever its own
  // relations constrain it.
  | { kind: "translateGroup"; dragging: boolean; plane: THREE.Plane; startPoint: THREE.Vector3; startPositions: Map<string, THREE.Vector3>; snapAxis: SnapAxis };

/** Applies (or clears) Shift-held axis-snap to a raw drag delta — see `SnapAxis`. Reads
 * and writes `armed.snapAxis` in place (picking a new axis on Shift's rising edge,
 * clearing it the instant Shift is released) and returns the delta to actually apply. */
function applyAxisSnap(armed: { snapAxis: SnapAxis }, rawDelta: THREE.Vector3, shiftHeld: boolean): THREE.Vector3 {
  if (!shiftHeld) {
    armed.snapAxis = null;
    return rawDelta;
  }
  if (!armed.snapAxis) {
    const ax = Math.abs(rawDelta.x);
    const ay = Math.abs(rawDelta.y);
    const az = Math.abs(rawDelta.z);
    armed.snapAxis = ax >= ay && ax >= az ? "x" : ay >= az ? "y" : "z";
  }
  return new THREE.Vector3(
    armed.snapAxis === "x" ? rawDelta.x : 0,
    armed.snapAxis === "y" ? rawDelta.y : 0,
    armed.snapAxis === "z" ? rawDelta.z : 0,
  );
}

// Below this many screen pixels from the rotation center, a screen-angle-based
// rotation (part-spin and free-arcball modes) becomes numerically unstable — a tiny
// cursor move sweeps a huge angle right at the center, which is exactly the "se
// imanta"/jumpy feeling this replaces. Skip the frame instead of computing a wild
// delta; incremental (not absolute-angle) tracking means skipping one frame near the
// center costs nothing once the cursor moves back out.
const MIN_PIVOT_RADIUS = 14;
const CAMERA_ORBIT_SENSITIVITY = 0.008; // rad per pixel of drag

function computeRotatePart(
  camera: SceneCamera,
  rect: DOMRect,
  curPos: THREE.Vector3,
  curQuat: THREE.Quaternion,
  lastScreen: THREE.Vector2,
  mouseScreen: THREE.Vector2,
): THREE.Quaternion | null {
  const centerNdc = curPos.clone().project(camera);
  const centerScreen = new THREE.Vector2(((centerNdc.x + 1) / 2) * rect.width, ((1 - centerNdc.y) / 2) * rect.height);
  const prevVec = lastScreen.clone().sub(centerScreen);
  const currVec = mouseScreen.clone().sub(centerScreen);
  if (prevVec.length() < MIN_PIVOT_RADIUS || currVec.length() < MIN_PIVOT_RADIUS) return null;
  prevVec.normalize();
  currVec.normalize();
  const cross = prevVec.x * currVec.y - prevVec.y * currVec.x;
  const dot = THREE.MathUtils.clamp(prevVec.dot(currVec), -1, 1);
  const deltaAngle = Math.atan2(cross, dot);
  const viewAxis = new THREE.Vector3();
  camera.getWorldDirection(viewAxis);
  const deltaQuat = new THREE.Quaternion().setFromAxisAngle(viewAxis, -deltaAngle);
  return deltaQuat.multiply(curQuat);
}

function computeRotateCamera(
  camera: SceneCamera,
  orbitTarget: THREE.Vector3,
  curPos: THREE.Vector3,
  curQuat: THREE.Quaternion,
  dx: number,
  dy: number,
): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  const rightAxis = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const upAxis = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  const yaw = dx * CAMERA_ORBIT_SENSITIVITY;
  const pitch = -dy * CAMERA_ORBIT_SENSITIVITY;
  const deltaQuat = new THREE.Quaternion()
    .setFromAxisAngle(upAxis, yaw)
    .multiply(new THREE.Quaternion().setFromAxisAngle(rightAxis, pitch));
  const offset = curPos.clone().sub(orbitTarget).applyQuaternion(deltaQuat);
  return { position: orbitTarget.clone().add(offset), quaternion: deltaQuat.clone().multiply(curQuat) };
}

function computeRotateFree(
  camera: SceneCamera,
  rect: DOMRect,
  curPos: THREE.Vector3,
  curQuat: THREE.Quaternion,
  lastScreen: THREE.Vector2,
  mouseScreen: THREE.Vector2,
): THREE.Quaternion | null {
  const centerNdc = curPos.clone().project(camera);
  const centerScreen = new THREE.Vector2(((centerNdc.x + 1) / 2) * rect.width, ((1 - centerNdc.y) / 2) * rect.height);
  const radius = Math.max(Math.min(rect.width, rect.height) * 0.4, 1);

  function mapToSphere(p: THREE.Vector2): THREE.Vector3 {
    const dx = (p.x - centerScreen.x) / radius;
    const dy = (p.y - centerScreen.y) / radius;
    const d2 = dx * dx + dy * dy;
    if (d2 <= 1) return new THREE.Vector3(dx, dy, Math.sqrt(1 - d2));
    const inv = 1 / Math.sqrt(d2);
    return new THREE.Vector3(dx * inv, dy * inv, 0);
  }

  const pPrev = mapToSphere(lastScreen);
  const pCurr = mapToSphere(mouseScreen);
  const dot = THREE.MathUtils.clamp(pPrev.dot(pCurr), -1, 1);
  const angle = Math.acos(dot);
  if (angle < 1e-5) return null;
  const axisLocal = new THREE.Vector3().crossVectors(pPrev, pCurr).normalize();
  if (!Number.isFinite(axisLocal.x)) return null;

  const rightAxis = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
  const upAxis = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  const forwardAxis = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2).normalize(); // toward viewer
  const axisWorld = rightAxis
    .clone()
    .multiplyScalar(axisLocal.x)
    .add(upAxis.clone().multiplyScalar(-axisLocal.y))
    .add(forwardAxis.clone().multiplyScalar(axisLocal.z))
    .normalize();
  const deltaQuat = new THREE.Quaternion().setFromAxisAngle(axisWorld, angle);
  return deltaQuat.multiply(curQuat);
}

function buildPartVisual(part: ImportedPart, color: number): PartVisual {
  const group = new THREE.Group();
  group.name = part.id;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(part.mesh.positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(part.mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(part.mesh.indices, 1));

  const material = new THREE.MeshStandardMaterial({ color, metalness: 0.15, roughness: 0.55 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.partId = part.id;
  group.add(mesh);

  // Each edge draws as a polyline of one or more straight segments (curved edges get
  // several — see EdgeInfo.polyline) concatenated into one LineSegments geometry, so
  // track which source edge each pair of vertices came from for picking/highlighting.
  const totalSegments = part.mesh.edges.reduce((sum, e) => sum + Math.max(0, e.polyline.length - 1), 0);
  const edgePositions = new Float32Array(totalSegments * 6);
  const edgeColors = new Float32Array(totalSegments * 6);
  const edgeSegmentIndex = new Int32Array(totalSegments);
  const baseColor = new THREE.Color(EDGE_COLOR);
  let seg = 0;
  part.mesh.edges.forEach((edge, edgeIdx) => {
    for (let i = 0; i < edge.polyline.length - 1; i++) {
      edgePositions.set([...edge.polyline[i], ...edge.polyline[i + 1]], seg * 6);
      edgeColors.set([baseColor.r, baseColor.g, baseColor.b, baseColor.r, baseColor.g, baseColor.b], seg * 6);
      edgeSegmentIndex[seg] = edgeIdx;
      seg++;
    }
  });
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
  edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColors, 3));
  const edgeMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6 });
  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edgeLines.userData.partId = part.id;
  group.add(edgeLines);

  return { group, mesh, material, baseColor: color, edgeLines, edgeSegmentIndex, highlightMesh: null };
}

function buildFaceHighlight(part: ImportedPart, faceId: number): THREE.Mesh | null {
  const { positions, indices, triangleFaceId } = part.mesh;
  const subset: number[] = [];
  for (let t = 0; t < triangleFaceId.length; t++) {
    if (triangleFaceId[t] === faceId) {
      subset.push(indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]);
    }
  }
  if (subset.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(subset);
  const material = new THREE.MeshBasicMaterial({
    color: PICK_COLOR,
    transparent: true,
    opacity: 0.45,
    side: THREE.DoubleSide,
    depthTest: true,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1;
  return mesh;
}

function updateEdgeHighlight(visual: PartVisual, part: ImportedPart, highlightedEdgeId: number | null): void {
  // A camera's gizmo geometry has no per-vertex "color" attribute (it's a single flat
  // LineBasicMaterial color, not vertex-colored real edges) — nothing to highlight.
  if (visual.isCamera) return;
  const colorAttr = visual.edgeLines.geometry.getAttribute("color") as THREE.BufferAttribute;
  const normal = new THREE.Color(EDGE_COLOR);
  const highlight = new THREE.Color(EDGE_HIGHLIGHT_COLOR);
  for (let seg = 0; seg < visual.edgeSegmentIndex.length; seg++) {
    const edge = part.mesh.edges[visual.edgeSegmentIndex[seg]];
    const c = edge?.id === highlightedEdgeId ? highlight : normal;
    colorAttr.setXYZ(seg * 2, c.r, c.g, c.b);
    colorAttr.setXYZ(seg * 2 + 1, c.r, c.g, c.b);
  }
  colorAttr.needsUpdate = true;
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<SceneCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const orbitRef = useRef<OrbitControls | null>(null);
  const visualsRef = useRef<Map<string, PartVisual>>(new Map());
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const armedDragRef = useRef<ArmedDrag | null>(null);
  const latestPointerRef = useRef<{ x: number; y: number; shiftKey: boolean } | null>(null);
  const viewSizeRef = useRef(200);
  const switchCameraRef = useRef<((kind: CameraProjection) => void) | null>(null);
  const setFovRef = useRef<((fov: number) => void) | null>(null);
  const applyPresetRef = useRef<((preset: ViewPreset) => void) | null>(null);
  const frameContentRef = useRef<((center: THREE.Vector3, radius: number, aspect: number) => void) | null>(null);

  const parts = useAssemblyStore((s) => s.parts);
  const partOrder = useAssemblyStore((s) => s.partOrder);
  const selectedPartId = useAssemblyStore((s) => s.selectedPartId);
  const selectedPartIds = useAssemblyStore((s) => s.selectedPartIds);
  const pickedEntities = useAssemblyStore((s) => s.pickedEntities);
  const requestedView = useAssemblyStore((s) => s.requestedView);
  const consumeRequestedView = useAssemblyStore((s) => s.consumeRequestedView);
  const importVersion = useAssemblyStore((s) => s.importVersion);
  const cameraProjection = useAssemblyStore((s) => s.cameraProjection);
  const perspectiveFov = useAssemblyStore((s) => s.perspectiveFov);
  const colorMode = useAssemblyStore((s) => s.colorMode);
  // Read once as the initial camera-kind seed on mount; later changes are picked up by the
  // separate switchCameraRef-driven effect below, not by re-running scene setup.
  const initialProjectionRef = useRef(cameraProjection);
  // Mirrors the latest fov (not read-once) — makePerspectiveCamera/switchCamera read it
  // lazily so switching *into* perspective later picks up whatever the slider is
  // currently set to, not just its value at mount.
  const perspectiveFovRef = useRef(perspectiveFov);
  useEffect(() => {
    perspectiveFovRef.current = perspectiveFov;
  }, [perspectiveFov]);

  // --- one-time scene setup ---
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x151515);
    sceneRef.current = scene;

    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    const aspect = width / height;

    function makeOrthoCamera(): THREE.OrthographicCamera {
      const viewSize = viewSizeRef.current;
      return new THREE.OrthographicCamera(-viewSize * aspect, viewSize * aspect, viewSize, -viewSize, -100000, 100000);
    }
    function makePerspectiveCamera(): THREE.PerspectiveCamera {
      return new THREE.PerspectiveCamera(perspectiveFovRef.current, aspect, 0.1, 100000);
    }

    // `camera`/`orbit` are reassigned (not just mutated) when the projection mode
    // toggles — every function below closes over these same outer bindings, so a
    // reassignment here is picked up everywhere else without any extra plumbing.
    let camera: SceneCamera = initialProjectionRef.current === "perspective" ? makePerspectiveCamera() : makeOrthoCamera();
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    rendererRef.current = renderer;
    container.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x212121, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.3);
    key.position.set(1, -1, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(-1, 1, -1);
    scene.add(fill);

    const grid = new THREE.GridHelper(2000, 40, 0x373737, 0x212121);
    grid.rotation.x = Math.PI / 2; // lie flat on the XY plane (scene is Z-up)
    scene.add(grid);

    const target = new THREE.Vector3(0, 0, 0);
    // `targetPoint` defaults to the origin (used only for the very first orbit, before
    // any orbit has ever existed to read a target from) — every rebuild afterwards
    // passes the outgoing orbit's own (possibly panned-away-from-origin) target
    // explicitly, so rebuilding orbit controls (projection switch, preset switch)
    // never silently snaps a panned view back to the origin.
    function makeOrbit(cam: SceneCamera, targetPoint: THREE.Vector3 = target): OrbitControls {
      const controls = new OrbitControls(cam, renderer.domElement);
      controls.target.copy(targetPoint);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      return controls;
    }
    // Apply the (Z-up) view preset — which sets `camera.up` — *before* constructing
    // OrbitControls: it reads `camera.up` exactly once, at construction, to build the
    // quaternion it uses internally to realign every rotate into a Y-up frame. Doing
    // this in the other order (as it used to be) leaves that first orbit instance
    // permanently built around the default Y-up assumption a freshly-constructed
    // THREE.Camera starts with, silently breaking mouse-drag orbit until the next
    // projection switch (which happens to set `up` before making its own new
    // OrbitControls) rebuilds it correctly.
    applyViewPreset(camera, target, "iso", fitDistance(camera, viewSizeRef.current));
    let orbit = makeOrbit(camera);
    orbitRef.current = orbit;
    orbit.update();

    function switchCamera(kind: CameraProjection) {
      const isPerspective = camera instanceof THREE.PerspectiveCamera;
      if ((kind === "perspective") === isPerspective) return;
      const oldPos = camera.position.clone();
      const oldUp = camera.up.clone();
      const oldTarget = orbit.target.clone();
      const distance = oldPos.distanceTo(oldTarget) || 300;

      const next = kind === "perspective" ? makePerspectiveCamera() : makeOrthoCamera();
      next.up.copy(oldUp);
      // Preserve the current view direction, re-deriving distance so the framed
      // content stays about the same apparent size across the switch.
      const dir = oldPos.clone().sub(oldTarget).normalize();
      next.position.copy(oldTarget).add(dir.multiplyScalar(fitDistance(next, viewSizeRef.current) || distance));
      next.lookAt(oldTarget);

      const w = containerRef.current?.clientWidth || width;
      const h = containerRef.current?.clientHeight || height;
      fitCameraFrustum(next, viewSizeRef.current, w / h);

      orbit.dispose();
      camera = next;
      orbit = makeOrbit(camera, oldTarget);
      orbit.update();
      cameraRef.current = camera;
      orbitRef.current = orbit;
    }
    switchCameraRef.current = switchCamera;

    // Rebuilds OrbitControls after every preset switch, not just projection switches —
    // "Superior" is the one preset with a different up vector ((0,1,0) vs the other
    // three's (0,0,1)), and applyViewPreset changes `camera.up` directly without
    // touching `orbit`; left alone, orbit's cached up-alignment quaternion (see the
    // comment above `let orbit = makeOrbit(camera)`) would go stale the same way,
    // silently breaking mouse-drag orbit after switching to/from Superior.
    function applyPreset(preset: ViewPreset) {
      const oldTarget = orbit.target.clone();
      const distance = camera.position.distanceTo(oldTarget) || 300;
      applyViewPreset(camera, oldTarget, preset, distance);
      orbit.dispose();
      orbit = makeOrbit(camera, oldTarget);
      orbit.update();
      orbitRef.current = orbit;
    }
    applyPresetRef.current = applyPreset;

    // Frames a bounding sphere (center/radius) in ISO view, e.g. after a fresh import —
    // same up-vector/orbit-rebuild reasoning as `applyPreset`: this always resets to
    // the ISO preset's up vector, which needs a fresh OrbitControls to match.
    function frameContent(center: THREE.Vector3, radius: number, aspect: number) {
      fitCameraFrustum(camera, radius, aspect);
      applyViewPreset(camera, center, "iso", fitDistance(camera, radius));
      orbit.dispose();
      orbit = makeOrbit(camera, center);
      orbit.update();
      orbitRef.current = orbit;
    }
    frameContentRef.current = frameContent;

    // Shapr3D-style "amount of perspective" slider: changes the PerspectiveCamera's
    // fov while dollying the camera so whatever's currently framed stays about the
    // same apparent size — a classic dolly-zoom, so the slider reads as "how much
    // perspective distortion" rather than "zoom in/out". No-op while the camera is
    // orthographic (there's no fov to vary); the store value still updates so the
    // next switch to perspective picks it up via `perspectiveFovRef`.
    function setFov(fov: number) {
      if (!(camera instanceof THREE.PerspectiveCamera)) return;
      const oldDistance = camera.position.distanceTo(orbit.target) || 300;
      const apparentRadius = oldDistance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      camera.fov = fov;
      const newDistance = apparentRadius / Math.tan(THREE.MathUtils.degToRad(fov / 2));
      const dir = camera.position.clone().sub(orbit.target).normalize();
      camera.position.copy(orbit.target).add(dir.multiplyScalar(newDistance));
      camera.updateProjectionMatrix();
      orbit.update();
    }
    setFovRef.current = setFov;

    const raycaster = new THREE.Raycaster();
    const dom = renderer.domElement;

    function raycasterFromEvent(clientX: number, clientY: number): THREE.Raycaster | null {
      const el = containerRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      // World units per screen pixel, at whatever depth is actually relevant — for
      // orthographic that's constant everywhere (frustum width / pixel width); for
      // perspective it grows with distance, so approximate it at the orbit target's
      // depth (where the assembly usually sits).
      const worldPerPixel =
        camera instanceof THREE.OrthographicCamera
          ? (camera.right - camera.left) / camera.zoom / rect.width
          : (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.distanceTo(orbit.target)) / rect.height;
      raycaster.params.Line = { threshold: worldPerPixel * 6 };
      return raycaster;
    }

    function pick(clientX: number, clientY: number, shiftKey: boolean, ctrlKey: boolean) {
      const rc = raycasterFromEvent(clientX, clientY);
      if (!rc) return;

      const { parts: currentParts, pickEntity, selectPart, toggleMultiSelect, clearMultiSelect } = useAssemblyStore.getState();
      const visuals = Array.from(visualsRef.current.values());

      const lineHits = rc.intersectObjects(visuals.map((v) => v.edgeLines), false);
      const faceHits = rc.intersectObjects(visuals.map((v) => v.mesh), false);
      const hitPartId = (lineHits[0] ?? faceHits[0])?.object.userData.partId as string | undefined;

      if (shiftKey) {
        // Shift-click always selects the whole object, never a single face/edge — that's
        // the point of the distinction from a plain click, which feeds the two-pick
        // relation flow below.
        if (hitPartId) toggleMultiSelect(hitPartId);
        return;
      }

      // Ctrl/Cmd-click is required to pick a specific face/edge (for building a
      // relation) — a plain click always selects the whole object instead, which is
      // both the safer default (no more "clicked a body and accidentally picked
      // whatever face the raycaster happened to hit first, sometimes the back one
      // through thin/overlapping geometry") and consistent with Ctrl-click already
      // meaning "get specific" everywhere else (tree panel multi-select). A camera has
      // no faces/edges to resolve a pick against, so it always falls back to
      // whole-object selection regardless of Ctrl.
      if (ctrlKey && hitPartId && !currentParts.get(hitPartId)?.isCamera) {
        clearMultiSelect();
        if (lineHits.length > 0) {
          const hit = lineHits[0];
          const partId = hit.object.userData.partId as string;
          const segmentIndex = Math.floor((hit.index ?? 0) / 2);
          const edgeIdx = visualsRef.current.get(partId)?.edgeSegmentIndex[segmentIndex];
          const edge = edgeIdx !== undefined ? currentParts.get(partId)?.part.mesh.edges[edgeIdx] : undefined;
          if (edge) {
            pickEntity({ partId, kind: "edge", id: edge.id });
            return;
          }
        }
        if (faceHits.length > 0) {
          const hit = faceHits[0];
          const partId = hit.object.userData.partId as string;
          const faceId = currentParts.get(partId)?.part.mesh.triangleFaceId[hit.faceIndex ?? 0];
          if (faceId !== undefined) {
            pickEntity({ partId, kind: "face", id: faceId });
            return;
          }
        }
      }

      clearMultiSelect();
      selectPart(hitPartId ?? null);
    }

    function onPointerDown(e: PointerEvent) {
      pointerDownRef.current = { x: e.clientX, y: e.clientY };
      latestPointerRef.current = { x: e.clientX, y: e.clientY, shiftKey: e.shiftKey };
      armedDragRef.current = null;

      const {
        selectedPartId: selId,
        selectedGroupId: selGroupId,
        selectedPartIds,
        parts: currentParts,
        transformMode,
        rotatePivotMode,
      } = useAssemblyStore.getState();

      // A named group drags every member; an ad-hoc multi-selection (2+ parts,
      // Ctrl/Cmd-click in the tree or Shift-click in the viewport) drags the same way
      // without needing to actually group them first — both go through the same rigid
      // multi-part drag (store.applyGroupDragPreview cares only about the id list).
      const multiIds = selGroupId
        ? Array.from(currentParts.entries())
            .filter(([, st]) => st.groupId === selGroupId && !st.fixed)
            .map(([id]) => id)
        : selectedPartIds.size >= 2
          ? Array.from(selectedPartIds).filter((id) => !currentParts.get(id)?.fixed)
          : null;

      if (multiIds && transformMode === "translate") {
        const rc = raycasterFromEvent(e.clientX, e.clientY);
        const hitMemberId = rc && multiIds.find((id) => {
          const v = visualsRef.current.get(id);
          return v && rc.intersectObject(v.mesh, false).length > 0;
        });
        if (rc && hitMemberId) {
          const hitVisual = visualsRef.current.get(hitMemberId)!;
          const viewDir = new THREE.Vector3();
          camera.getWorldDirection(viewDir);
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDir, hitVisual.group.position);
          const startPoint = new THREE.Vector3();
          if (rc.ray.intersectPlane(plane, startPoint)) {
            const startPositions = new Map<string, THREE.Vector3>();
            for (const id of multiIds) {
              const v = visualsRef.current.get(id);
              if (v) startPositions.set(id, v.group.position.clone());
            }
            orbit.enabled = false;
            armedDragRef.current = { kind: "translateGroup", dragging: false, plane, startPoint, startPositions, snapAxis: null };
          }
          return;
        }
      }

      if (!selId) return;
      const state = currentParts.get(selId);
      const visual = visualsRef.current.get(selId);
      if (!state || !visual || state.fixed) return;
      const rc = raycasterFromEvent(e.clientX, e.clientY);
      if (!rc || rc.intersectObject(visual.mesh, false).length === 0) return;

      // Might turn out to be just a tap (handled as a pick on pointerup) — disabling
      // orbit now regardless is harmless since nothing would have orbited from a
      // non-moving click anyway, and it avoids a one-frame camera flash if it does
      // turn into a drag.
      orbit.enabled = false;

      if (transformMode === "translate") {
        const viewDir = new THREE.Vector3();
        camera.getWorldDirection(viewDir);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(viewDir, visual.group.position);
        const startPoint = new THREE.Vector3();
        if (!rc.ray.intersectPlane(plane, startPoint)) return;
        armedDragRef.current = {
          kind: "translate",
          partId: selId,
          dragging: false,
          plane,
          startPoint,
          startPosition: visual.group.position.clone(),
          snapAxis: null,
        };
      } else {
        const rect = containerRef.current!.getBoundingClientRect();
        armedDragRef.current = {
          kind: "rotate",
          partId: selId,
          dragging: false,
          pivotMode: rotatePivotMode,
          lastScreen: new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top),
        };
      }
    }

    function onPointerMove(e: PointerEvent) {
      latestPointerRef.current = { x: e.clientX, y: e.clientY, shiftKey: e.shiftKey };
      const armed = armedDragRef.current;
      if (!armed) {
        // Cursor affordance: "grab" over the draggable selected part (or any member of
        // the selected group / multi-selection, when in translate mode), default elsewhere.
        const {
          selectedPartId: selId,
          selectedGroupId: selGroupId,
          selectedPartIds,
          parts: currentParts,
          transformMode: mode,
        } = useAssemblyStore.getState();
        let hovering = false;
        const multiIds = selGroupId
          ? Array.from(currentParts.entries()).filter(([, st]) => st.groupId === selGroupId && !st.fixed).map(([id]) => id)
          : selectedPartIds.size >= 2
            ? Array.from(selectedPartIds)
            : null;
        if (multiIds && mode === "translate") {
          const rc = raycasterFromEvent(e.clientX, e.clientY);
          hovering = !!rc && multiIds.some(
            (id) => !currentParts.get(id)?.fixed && (visualsRef.current.get(id)?.mesh ? rc.intersectObject(visualsRef.current.get(id)!.mesh, false).length > 0 : false),
          );
        }
        if (!hovering && selId) {
          const visual = visualsRef.current.get(selId);
          if (visual) {
            const rc = raycasterFromEvent(e.clientX, e.clientY);
            hovering = !!rc && rc.intersectObject(visual.mesh, false).length > 0;
          }
        }
        dom.style.cursor = hovering ? "grab" : "";
        return;
      }

      if (!armed.dragging) {
        const start = pointerDownRef.current;
        if (!start || Math.hypot(e.clientX - start.x, e.clientY - start.y) <= 4) return;
        armed.dragging = true;
        useAssemblyStore.getState().pushHistorySnapshot();
        dom.style.cursor = "grabbing";
      }
    }

    // The actual per-frame drag solve is throttled to the render loop (below) rather
    // than run on every raw pointermove — pointermove can fire faster than the solver
    // (and the resulting store update + React re-render) can keep up with, and letting
    // them queue up is exactly what produces a laggy, "catches up in bursts" feel.
    function processDragFrame() {
      const armed = armedDragRef.current;
      const pointer = latestPointerRef.current;
      if (!armed || !armed.dragging || !pointer) return;

      const store = useAssemblyStore.getState();
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      if (armed.kind === "translateGroup") {
        const rc = raycasterFromEvent(pointer.x, pointer.y);
        if (!rc) return;
        const hit = new THREE.Vector3();
        if (!rc.ray.intersectPlane(armed.plane, hit)) return;
        const delta = applyAxisSnap(armed, hit.sub(armed.startPoint), pointer.shiftKey);
        const patches = Array.from(armed.startPositions.entries()).map(([partId, startPosition]) => {
          const target = startPosition.clone().add(delta);
          return { partId, position: [target.x, target.y, target.z] as [number, number, number] };
        });
        store.applyGroupDragPreview(patches);
        return;
      }

      const currentState = store.parts.get(armed.partId);
      if (!currentState) return;
      const curPos = new THREE.Vector3(...currentState.pose.position);
      const curQuat = new THREE.Quaternion(...currentState.pose.quaternion);

      if (armed.kind === "translate") {
        const rc = raycasterFromEvent(pointer.x, pointer.y);
        if (!rc) return;
        const hit = new THREE.Vector3();
        if (!rc.ray.intersectPlane(armed.plane, hit)) return;
        const delta = applyAxisSnap(armed, hit.sub(armed.startPoint), pointer.shiftKey);
        const target = armed.startPosition.clone().add(delta);
        store.applyDragPreview(armed.partId, { position: [target.x, target.y, target.z] });
        return;
      }

      const mouseScreen = new THREE.Vector2(pointer.x - rect.left, pointer.y - rect.top);
      if (mouseScreen.distanceTo(armed.lastScreen) < 0.5) return; // no real movement since last frame

      let targetPosition: THREE.Vector3 | undefined;
      let targetQuaternion: THREE.Quaternion | null;
      if (armed.pivotMode === "part") {
        targetQuaternion = computeRotatePart(camera, rect, curPos, curQuat, armed.lastScreen, mouseScreen);
      } else if (armed.pivotMode === "camera") {
        const dx = mouseScreen.x - armed.lastScreen.x;
        const dy = mouseScreen.y - armed.lastScreen.y;
        const result = computeRotateCamera(camera, orbit.target, curPos, curQuat, dx, dy);
        targetPosition = result.position;
        targetQuaternion = result.quaternion;
      } else {
        targetQuaternion = computeRotateFree(camera, rect, curPos, curQuat, armed.lastScreen, mouseScreen);
      }
      armed.lastScreen = mouseScreen;
      if (!targetQuaternion) return;
      store.applyDragPreview(armed.partId, {
        position: targetPosition ? [targetPosition.x, targetPosition.y, targetPosition.z] : undefined,
        quaternion: [targetQuaternion.x, targetQuaternion.y, targetQuaternion.z, targetQuaternion.w],
      });
    }

    function onPointerUp(e: PointerEvent) {
      const armed = armedDragRef.current;
      armedDragRef.current = null;
      if (armed) {
        orbit.enabled = true;
        dom.style.cursor = "";
        if (armed.dragging) {
          useAssemblyStore.getState().runSolve();
          return;
        }
        // Armed but never crossed the drag threshold — treat as a plain click below.
      }
      const start = pointerDownRef.current;
      pointerDownRef.current = null;
      if (!start) return;
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 4) return;
      pick(e.clientX, e.clientY, e.shiftKey, e.ctrlKey || e.metaKey);
    }

    // WASD camera orbit — an alternative to dragging on empty space to orbit: W/S tilt
    // the view toward the top/bottom, A/D swing it left/right. Applied by editing the
    // camera's spherical position around orbit.target directly and letting the next
    // orbit.update() pick it up (it re-derives its internal spherical state from
    // camera.position every call, so this composes cleanly with mouse-driven orbiting).
    const heldKeys = new Set<string>();
    const CAMERA_KEY_SPEED = 1.4; // rad/sec
    function isTextInput(el: EventTarget | null): boolean {
      return el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    }
    function onWindowKeyDown(e: KeyboardEvent) {
      const k = e.key.toLowerCase();
      if (k !== "w" && k !== "a" && k !== "s" && k !== "d") return;
      if (isTextInput(e.target)) return;
      heldKeys.add(k);
    }
    function onWindowKeyUp(e: KeyboardEvent) {
      heldKeys.delete(e.key.toLowerCase());
    }
    window.addEventListener("keydown", onWindowKeyDown);
    window.addEventListener("keyup", onWindowKeyUp);

    // POV picture-in-picture: when a camera object is selected, its view renders into a
    // corner of the same canvas via a scissored sub-viewport (cheaper than a second
    // WebGL context) right after the main render — see the bottom-right overlay div in
    // the JSX for the matching border/label.
    const povCamera = new THREE.PerspectiveCamera(50, PIP_W / PIP_H, 0.1, 100000);
    function renderPovWidget(w: number, h: number) {
      const { selectedPartId: selId, parts: currentParts } = useAssemblyStore.getState();
      const camState = selId ? currentParts.get(selId) : undefined;
      if (!camState?.isCamera) return;
      const visual = visualsRef.current.get(selId!);
      if (!visual) return;

      povCamera.position.copy(visual.group.position);
      povCamera.quaternion.copy(visual.group.quaternion);
      povCamera.fov = camState.cameraFov ?? 50;
      povCamera.updateProjectionMatrix();

      const pipX = w - PIP_W - PIP_MARGIN;
      const pipY = PIP_MARGIN; // WebGL viewport/scissor Y is bottom-up, matching the CSS `bottom` offset used for the overlay
      visual.edgeLines.visible = false; // don't let the camera see its own gizmo
      renderer.setScissorTest(true);
      renderer.setScissor(pipX, pipY, PIP_W, PIP_H);
      renderer.setViewport(pipX, pipY, PIP_W, PIP_H);
      renderer.clearDepth();
      renderer.render(scene, povCamera);
      visual.edgeLines.visible = true;
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, w, h);
    }

    // The POV widget is a live preview, not something that needs to track the main
    // render loop's own framerate — throttling it to ~20fps roughly halves the
    // per-frame GPU cost of having a camera selected (it renders the *entire* scene a
    // second time) with no visible smoothness loss, which matters a lot once that cost
    // is compounding with keyframe playback's own per-frame solve+render on top of it.
    const POV_INTERVAL_MS = 50;
    let lastPovRenderTime = 0;

    let raf = 0;
    let lastFrameTime = performance.now();
    const animate = (now: number) => {
      const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
      lastFrameTime = now;

      if (heldKeys.size > 0) {
        // THREE.Spherical's pole is the Y axis — fine for a default Y-up scene, but
        // this one is Z-up (see viewPresets.ts), so its phi/theta don't correspond to
        // "tilt"/"swing" here at all: rotating theta actually orbits around whatever
        // arbitrary horizontal direction Y happens to be, tracing a cone around it
        // (never showing the opposite side) rather than turning like a turntable
        // around the vertical axis, and it can go nearly inert at some view angles
        // (Frontal view puts the camera offset almost exactly on Spherical's own pole,
        // a gimbal-like singularity where changing theta barely moves anything).
        // OrbitControls sidesteps this by rotating into a frame where camera.up maps
        // to +Y before doing the spherical math, and back out after — do the same here.
        const upAlign = new THREE.Quaternion().setFromUnitVectors(camera.up, new THREE.Vector3(0, 1, 0));
        const upAlignInv = upAlign.clone().invert();
        const offset = camera.position.clone().sub(orbit.target).applyQuaternion(upAlign);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        if (heldKeys.has("a")) spherical.theta += CAMERA_KEY_SPEED * dt;
        if (heldKeys.has("d")) spherical.theta -= CAMERA_KEY_SPEED * dt;
        if (heldKeys.has("w")) spherical.phi -= CAMERA_KEY_SPEED * dt;
        if (heldKeys.has("s")) spherical.phi += CAMERA_KEY_SPEED * dt;
        spherical.phi = THREE.MathUtils.clamp(spherical.phi, 0.01, Math.PI - 0.01);
        offset.setFromSpherical(spherical).applyQuaternion(upAlignInv);
        camera.position.copy(orbit.target).add(offset);
      }

      orbit.update();
      processDragFrame();
      renderer.render(scene, camera);
      const el = containerRef.current;
      if (el && el.clientWidth > 0 && el.clientHeight > 0 && now - lastPovRenderTime >= POV_INTERVAL_MS) {
        lastPovRenderTime = now;
        renderPovWidget(el.clientWidth, el.clientHeight);
      }
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);

    const resizeObserver = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      fitCameraFrustum(camera, viewSizeRef.current, w / h, false);
      renderer.setSize(w, h);
    });
    resizeObserver.observe(container);

    dom.addEventListener("pointerdown", onPointerDown);
    dom.addEventListener("pointermove", onPointerMove);
    dom.addEventListener("pointerup", onPointerUp);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("pointermove", onPointerMove);
      dom.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onWindowKeyDown);
      window.removeEventListener("keyup", onWindowKeyUp);
      orbit.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      orbitRef.current = null;
    };
  }, []);

  // Tracks the non-pose inputs the reconcile effect below also depends on — selection,
  // picking, and color mode — so it can tell whether THIS run was triggered purely by a
  // pose update (the common case during keyframe playback/live drag) versus one of
  // these, which can change what ANY part's visual should look like and so always needs
  // the full per-part pass. See lastReconciledState on PartVisual for the pose side.
  const lastReconcileDepsRef = useRef<{
    selectedPartId: string | null;
    selectedPartIds: Set<string>;
    pickedEntities: typeof pickedEntities;
    colorMode: typeof colorMode;
  } | null>(null);

  // --- reconcile part visuals against store state ---
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const visuals = visualsRef.current;

    for (const [id, visual] of visuals) {
      if (!parts.has(id)) {
        scene.remove(visual.group);
        visual.mesh.geometry.dispose();
        visual.material.dispose();
        visual.edgeLines.geometry.dispose();
        (visual.edgeLines.material as THREE.Material).dispose();
        if (visual.highlightMesh) {
          visual.highlightMesh.geometry.dispose();
          (visual.highlightMesh.material as THREE.Material).dispose();
        }
        visuals.delete(id);
      }
    }

    // Only true when selection/picking/color-mode are byte-for-byte the same object
    // references as last run — i.e. this run exists purely because some part's pose
    // changed. A changed Set/array reference (even with the same logical contents)
    // falls through to the full pass below; that's fine, it only costs the fast path on
    // a rare event, never correctness.
    const prevDeps = lastReconcileDepsRef.current;
    const onlyPoseChanged =
      prevDeps !== null &&
      prevDeps.selectedPartId === selectedPartId &&
      prevDeps.selectedPartIds === selectedPartIds &&
      prevDeps.pickedEntities === pickedEntities &&
      prevDeps.colorMode === colorMode;
    lastReconcileDepsRef.current = { selectedPartId, selectedPartIds, pickedEntities, colorMode };

    partOrder.forEach((id, index) => {
      const state = parts.get(id);
      if (!state) return;
      let visual = visuals.get(id);
      if (!visual) {
        visual = state.isCamera ? buildCameraVisual(id) : buildPartVisual(state.part, partColor(index));
        scene.add(visual.group);
        visuals.set(id, visual);
      }
      if (onlyPoseChanged && visual.lastReconciledState === state) return;
      visual.lastReconciledState = state;
      visual.group.position.set(...state.pose.position);
      visual.group.quaternion.set(...state.pose.quaternion);
      visual.group.visible = state.visible;
      const isSelected = id === selectedPartId || selectedPartIds.has(id);
      if (visual.isCamera) {
        (visual.edgeLines.material as THREE.LineBasicMaterial).color.setHex(
          isSelected ? CAMERA_GIZMO_SELECTED_COLOR : CAMERA_GIZMO_COLOR,
        );
      } else {
        const bodyColor = state.color ?? (colorMode === "gray" ? UNIFORM_GRAY_COLOR : visual.baseColor);
        visual.material.color.setHex(isSelected ? SELECTED_PART_COLOR : bodyColor);
      }

      if (visual.highlightMesh) {
        visual.group.remove(visual.highlightMesh);
        visual.highlightMesh.geometry.dispose();
        (visual.highlightMesh.material as THREE.Material).dispose();
        visual.highlightMesh = null;
      }
      const pickedFace = pickedEntities.find((e) => e.partId === id && e.kind === "face");
      if (pickedFace) {
        const overlay = buildFaceHighlight(state.part, pickedFace.id);
        if (overlay) {
          visual.group.add(overlay);
          visual.highlightMesh = overlay;
        }
      }

      const pickedEdge = pickedEntities.find((e) => e.partId === id && e.kind === "edge");
      updateEdgeHighlight(visual, state.part, pickedEdge?.id ?? null);
    });
  }, [parts, partOrder, selectedPartId, selectedPartIds, pickedEntities, colorMode]);

  // --- camera projection toggle (ortho <-> perspective) ---
  useEffect(() => {
    switchCameraRef.current?.(cameraProjection);
  }, [cameraProjection]);

  // --- perspective amount slider (dolly-zoom fov change) ---
  useEffect(() => {
    setFovRef.current?.(perspectiveFov);
  }, [perspectiveFov]);

  // --- view preset requests ---
  useEffect(() => {
    if (!requestedView) return;
    applyPresetRef.current?.(requestedView);
    consumeRequestedView();
  }, [requestedView, consumeRequestedView]);

  // --- frame the whole assembly after a fresh import ---
  useEffect(() => {
    if (importVersion === 0) return;
    const raf = requestAnimationFrame(() => {
      const box = new THREE.Box3();
      for (const visual of visualsRef.current.values()) box.expandByObject(visual.group);
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z, 10) * 0.75;
      viewSizeRef.current = radius;
      const el = containerRef.current;
      const aspect = el && el.clientHeight > 0 ? el.clientWidth / el.clientHeight : 1;
      frameContentRef.current?.(center, radius, aspect);
    });
    return () => cancelAnimationFrame(raf);
  }, [importVersion]);

  const povCameraState = selectedPartId ? parts.get(selectedPartId) : undefined;
  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {povCameraState?.isCamera && (
        <div
          className="pointer-events-none absolute overflow-hidden rounded"
          style={{
            width: PIP_W,
            height: PIP_H,
            right: PIP_MARGIN,
            bottom: PIP_MARGIN,
            border: "1px solid #ffcc55",
            boxShadow: "0 2px 10px rgba(0,0,0,0.5)",
          }}
        >
          <span
            className="absolute left-1 top-1 rounded px-1 text-[10px] font-medium"
            style={{ background: "rgba(0,0,0,0.55)", color: "#ffcc55" }}
          >
            POV · {povCameraState.part.name}
          </span>
        </div>
      )}
    </div>
  );
}

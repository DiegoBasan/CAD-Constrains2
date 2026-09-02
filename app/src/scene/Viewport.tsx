import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useAssemblyStore, type RotatePivotMode } from "../assembly/store";
import type { ImportedPart } from "../occ/types";
import { EDGE_COLOR, EDGE_HIGHLIGHT_COLOR, PICK_COLOR, SELECTED_PART_COLOR, partColor } from "./colors";
import { applyViewPreset } from "./viewPresets";

interface PartVisual {
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  baseColor: number;
  edgeLines: THREE.LineSegments;
  highlightMesh: THREE.Mesh | null;
}

/** An in-progress direct-manipulation drag on the selected part's body — free (not
 * axis-constrained) translate in the camera's view plane, or one of three rotate
 * pivots (see RotatePivotMode). Armed on pointerdown over the part; only becomes an
 * actual drag once the pointer moves past the click threshold, so a plain tap still
 * falls through to face/edge picking. Every frame's target seeds the solver's starting
 * guess for the dragged part (store.applyDragPreview) instead of its last-solved pose,
 * so the part tracks the cursor exactly where relations leave it free, and is pulled
 * back only along whatever they actually constrain — in real time, not just on release. */
type ArmedDrag =
  | { kind: "translate"; partId: string; dragging: boolean; plane: THREE.Plane; startPoint: THREE.Vector3; startPosition: THREE.Vector3 }
  | { kind: "rotate"; partId: string; dragging: boolean; pivotMode: RotatePivotMode; lastScreen: THREE.Vector2 };

// Below this many screen pixels from the rotation center, a screen-angle-based
// rotation (part-spin and free-arcball modes) becomes numerically unstable — a tiny
// cursor move sweeps a huge angle right at the center, which is exactly the "se
// imanta"/jumpy feeling this replaces. Skip the frame instead of computing a wild
// delta; incremental (not absolute-angle) tracking means skipping one frame near the
// center costs nothing once the cursor moves back out.
const MIN_PIVOT_RADIUS = 14;
const CAMERA_ORBIT_SENSITIVITY = 0.008; // rad per pixel of drag

function computeRotatePart(
  camera: THREE.OrthographicCamera,
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
  camera: THREE.OrthographicCamera,
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
  camera: THREE.OrthographicCamera,
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

  const edgeCount = part.mesh.edges.length;
  const edgePositions = new Float32Array(edgeCount * 6);
  const edgeColors = new Float32Array(edgeCount * 6);
  const baseColor = new THREE.Color(EDGE_COLOR);
  part.mesh.edges.forEach((edge, i) => {
    edgePositions.set([...edge.a, ...edge.b], i * 6);
    edgeColors.set([baseColor.r, baseColor.g, baseColor.b, baseColor.r, baseColor.g, baseColor.b], i * 6);
  });
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
  edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColors, 3));
  const edgeMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6 });
  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edgeLines.userData.partId = part.id;
  group.add(edgeLines);

  return { group, mesh, material, baseColor: color, edgeLines, highlightMesh: null };
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
  const colorAttr = visual.edgeLines.geometry.getAttribute("color") as THREE.BufferAttribute;
  const normal = new THREE.Color(EDGE_COLOR);
  const highlight = new THREE.Color(EDGE_HIGHLIGHT_COLOR);
  part.mesh.edges.forEach((edge, i) => {
    const c = edge.id === highlightedEdgeId ? highlight : normal;
    colorAttr.setXYZ(i * 2, c.r, c.g, c.b);
    colorAttr.setXYZ(i * 2 + 1, c.r, c.g, c.b);
  });
  colorAttr.needsUpdate = true;
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const orbitRef = useRef<OrbitControls | null>(null);
  const visualsRef = useRef<Map<string, PartVisual>>(new Map());
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const armedDragRef = useRef<ArmedDrag | null>(null);
  const latestPointerRef = useRef<{ x: number; y: number } | null>(null);
  const viewSizeRef = useRef(200);

  const parts = useAssemblyStore((s) => s.parts);
  const partOrder = useAssemblyStore((s) => s.partOrder);
  const selectedPartId = useAssemblyStore((s) => s.selectedPartId);
  const pickedEntities = useAssemblyStore((s) => s.pickedEntities);
  const requestedView = useAssemblyStore((s) => s.requestedView);
  const consumeRequestedView = useAssemblyStore((s) => s.consumeRequestedView);
  const importVersion = useAssemblyStore((s) => s.importVersion);

  // --- one-time scene setup ---
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0d12);
    sceneRef.current = scene;

    const width = container.clientWidth || 1;
    const height = container.clientHeight || 1;
    const aspect = width / height;
    const viewSize = viewSizeRef.current;
    const camera = new THREE.OrthographicCamera(
      -viewSize * aspect, viewSize * aspect, viewSize, -viewSize, -100000, 100000,
    );
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    rendererRef.current = renderer;
    container.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x1a1c22, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.3);
    key.position.set(1, -1, 2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(-1, 1, -1);
    scene.add(fill);

    const grid = new THREE.GridHelper(2000, 40, 0x2a2e3a, 0x1a1c24);
    grid.rotation.x = Math.PI / 2; // lie flat on the XY plane (scene is Z-up)
    scene.add(grid);

    const target = new THREE.Vector3(0, 0, 0);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.copy(target);
    orbit.enableDamping = true;
    orbit.dampingFactor = 0.08;
    orbitRef.current = orbit;
    applyViewPreset(camera, target, "iso", 300);
    orbit.update();

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
      const frustumWidth = (camera.right - camera.left) / camera.zoom;
      raycaster.params.Line = { threshold: (frustumWidth / rect.width) * 6 };
      return raycaster;
    }

    function pick(clientX: number, clientY: number) {
      const rc = raycasterFromEvent(clientX, clientY);
      if (!rc) return;

      const { parts: currentParts, pickEntity, selectPart } = useAssemblyStore.getState();
      const visuals = Array.from(visualsRef.current.values());

      const lineHits = rc.intersectObjects(visuals.map((v) => v.edgeLines), false);
      if (lineHits.length > 0) {
        const hit = lineHits[0];
        const partId = hit.object.userData.partId as string;
        const segmentIndex = Math.floor((hit.index ?? 0) / 2);
        const edge = currentParts.get(partId)?.part.mesh.edges[segmentIndex];
        if (edge) {
          pickEntity({ partId, kind: "edge", id: edge.id });
          return;
        }
      }

      const faceHits = rc.intersectObjects(visuals.map((v) => v.mesh), false);
      if (faceHits.length > 0) {
        const hit = faceHits[0];
        const partId = hit.object.userData.partId as string;
        const faceId = currentParts.get(partId)?.part.mesh.triangleFaceId[hit.faceIndex ?? 0];
        if (faceId !== undefined) {
          pickEntity({ partId, kind: "face", id: faceId });
          return;
        }
      }
      selectPart(null);
    }

    function onPointerDown(e: PointerEvent) {
      pointerDownRef.current = { x: e.clientX, y: e.clientY };
      latestPointerRef.current = { x: e.clientX, y: e.clientY };
      armedDragRef.current = null;

      const { selectedPartId: selId, parts: currentParts, transformMode, rotatePivotMode } = useAssemblyStore.getState();
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
      latestPointerRef.current = { x: e.clientX, y: e.clientY };
      const armed = armedDragRef.current;
      if (!armed) {
        // Cursor affordance: "grab" over the draggable selected part, default elsewhere.
        const selId = useAssemblyStore.getState().selectedPartId;
        const visual = selId ? visualsRef.current.get(selId) : undefined;
        if (visual) {
          const rc = raycasterFromEvent(e.clientX, e.clientY);
          dom.style.cursor = rc && rc.intersectObject(visual.mesh, false).length > 0 ? "grab" : "";
        } else {
          dom.style.cursor = "";
        }
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
      const currentState = store.parts.get(armed.partId);
      if (!currentState) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const curPos = new THREE.Vector3(...currentState.pose.position);
      const curQuat = new THREE.Quaternion(...currentState.pose.quaternion);

      if (armed.kind === "translate") {
        const rc = raycasterFromEvent(pointer.x, pointer.y);
        if (!rc) return;
        const hit = new THREE.Vector3();
        if (!rc.ray.intersectPlane(armed.plane, hit)) return;
        const target = armed.startPosition.clone().add(hit.sub(armed.startPoint));
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
      pick(e.clientX, e.clientY);
    }

    let raf = 0;
    const animate = () => {
      orbit.update();
      processDragFrame();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    const resizeObserver = new ResizeObserver(() => {
      const el = containerRef.current;
      if (!el) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) return;
      const a = w / h;
      const vs = viewSizeRef.current;
      camera.left = -vs * a;
      camera.right = vs * a;
      camera.top = vs;
      camera.bottom = -vs;
      camera.updateProjectionMatrix();
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
      orbit.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      orbitRef.current = null;
    };
  }, []);

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

    partOrder.forEach((id, index) => {
      const state = parts.get(id);
      if (!state) return;
      let visual = visuals.get(id);
      if (!visual) {
        visual = buildPartVisual(state.part, partColor(index));
        scene.add(visual.group);
        visuals.set(id, visual);
      }
      visual.group.position.set(...state.pose.position);
      visual.group.quaternion.set(...state.pose.quaternion);
      visual.group.visible = state.visible;
      visual.material.color.setHex(id === selectedPartId ? SELECTED_PART_COLOR : visual.baseColor);

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
  }, [parts, partOrder, selectedPartId, pickedEntities]);

  // --- view preset requests ---
  useEffect(() => {
    if (!requestedView) return;
    const camera = cameraRef.current;
    const orbit = orbitRef.current;
    if (!camera || !orbit) return;
    const distance = camera.position.distanceTo(orbit.target) || 300;
    applyViewPreset(camera, orbit.target, requestedView, distance);
    orbit.update();
    consumeRequestedView();
  }, [requestedView, consumeRequestedView]);

  // --- frame the whole assembly after a fresh import ---
  useEffect(() => {
    if (importVersion === 0) return;
    const raf = requestAnimationFrame(() => {
      const camera = cameraRef.current;
      const orbit = orbitRef.current;
      if (!camera || !orbit) return;
      const box = new THREE.Box3();
      for (const visual of visualsRef.current.values()) box.expandByObject(visual.group);
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z, 10) * 0.75;
      viewSizeRef.current = radius;
      const aspect = (camera.right - camera.left) / (camera.top - camera.bottom);
      camera.top = radius;
      camera.bottom = -radius;
      camera.left = -radius * aspect;
      camera.right = radius * aspect;
      camera.zoom = 1;
      camera.updateProjectionMatrix();
      orbit.target.copy(center);
      applyViewPreset(camera, center, "iso", radius * 3);
      orbit.update();
    });
    return () => cancelAnimationFrame(raf);
  }, [importVersion]);

  return <div ref={containerRef} className="h-full w-full" />;
}

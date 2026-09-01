import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useAssemblyStore } from "../assembly/store";
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
 * axis-constrained) translate in the camera's view plane, or free spin about the
 * view axis for rotate. Armed on pointerdown over the part; only becomes an actual
 * drag once the pointer moves past the click threshold, so a plain tap still falls
 * through to face/edge picking. */
type ArmedDrag =
  | {
      kind: "translate";
      partId: string;
      dragging: boolean;
      plane: THREE.Plane;
      startPoint: THREE.Vector3;
      startPosition: THREE.Vector3;
      startQuaternion: THREE.Quaternion;
    }
  | {
      kind: "rotate";
      partId: string;
      dragging: boolean;
      centerScreen: THREE.Vector2;
      startAngle: number;
      viewAxis: THREE.Vector3;
      startPosition: THREE.Vector3;
      startQuaternion: THREE.Quaternion;
    };

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
      armedDragRef.current = null;

      const { selectedPartId: selId, parts: currentParts, transformMode } = useAssemblyStore.getState();
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
          startQuaternion: visual.group.quaternion.clone(),
        };
      } else {
        const rect = containerRef.current!.getBoundingClientRect();
        const centerNdc = visual.group.position.clone().project(camera);
        const centerScreen = new THREE.Vector2(
          ((centerNdc.x + 1) / 2) * rect.width,
          ((1 - centerNdc.y) / 2) * rect.height,
        );
        const mouseScreen = new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top);
        const startAngle = Math.atan2(mouseScreen.y - centerScreen.y, mouseScreen.x - centerScreen.x);
        const viewAxis = new THREE.Vector3();
        camera.getWorldDirection(viewAxis);
        armedDragRef.current = {
          kind: "rotate",
          partId: selId,
          dragging: false,
          centerScreen,
          startAngle,
          viewAxis,
          startPosition: visual.group.position.clone(),
          startQuaternion: visual.group.quaternion.clone(),
        };
      }
    }

    function onPointerMove(e: PointerEvent) {
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

      const rc = raycasterFromEvent(e.clientX, e.clientY);
      if (!rc) return;
      const visual = visualsRef.current.get(armed.partId);
      if (!visual) return;

      let position: THREE.Vector3;
      let quaternion: THREE.Quaternion;
      if (armed.kind === "translate") {
        const hit = new THREE.Vector3();
        if (!rc.ray.intersectPlane(armed.plane, hit)) return;
        position = armed.startPosition.clone().add(hit.sub(armed.startPoint));
        quaternion = armed.startQuaternion.clone();
      } else {
        const rect = containerRef.current!.getBoundingClientRect();
        const mouseScreen = new THREE.Vector2(e.clientX - rect.left, e.clientY - rect.top);
        const angle = Math.atan2(mouseScreen.y - armed.centerScreen.y, mouseScreen.x - armed.centerScreen.x);
        const delta = angle - armed.startAngle;
        const deltaQuat = new THREE.Quaternion().setFromAxisAngle(armed.viewAxis, delta);
        quaternion = deltaQuat.multiply(armed.startQuaternion.clone());
        position = armed.startPosition.clone();
      }

      visual.group.position.copy(position);
      visual.group.quaternion.copy(quaternion);
      useAssemblyStore.getState().setPose(armed.partId, {
        position: [position.x, position.y, position.z],
        quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
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

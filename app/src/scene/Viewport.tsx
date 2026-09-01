import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { useAssemblyStore } from "../assembly/store";
import type { ImportedPart } from "../occ/types";
import { EDGE_COLOR, EDGE_HIGHLIGHT_COLOR, PICK_COLOR, partColor } from "./colors";
import { applyViewPreset } from "./viewPresets";

interface PartVisual {
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  edgeLines: THREE.LineSegments;
  highlightMesh: THREE.Mesh | null;
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

  return { group, mesh, material, edgeLines, highlightMesh: null };
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
  const transformRef = useRef<TransformControls | null>(null);
  const visualsRef = useRef<Map<string, PartVisual>>(new Map());
  const pointerDownRef = useRef<{ x: number; y: number } | null>(null);
  const viewSizeRef = useRef(200);

  const parts = useAssemblyStore((s) => s.parts);
  const partOrder = useAssemblyStore((s) => s.partOrder);
  const selectedPartId = useAssemblyStore((s) => s.selectedPartId);
  const pickedEntities = useAssemblyStore((s) => s.pickedEntities);
  const transformMode = useAssemblyStore((s) => s.transformMode);
  const requestedView = useAssemblyStore((s) => s.requestedView);
  const consumeRequestedView = useAssemblyStore((s) => s.consumeRequestedView);
  const fileName = useAssemblyStore((s) => s.fileName);

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

    const transform = new TransformControls(camera, renderer.domElement);
    transform.setSize(0.9);
    scene.add(transform.getHelper());
    transformRef.current = transform;
    transform.addEventListener("dragging-changed", (event) => {
      orbit.enabled = !event.value;
      if (!event.value) useAssemblyStore.getState().runSolve();
    });
    transform.addEventListener("objectChange", () => {
      const obj = transform.object;
      if (!obj) return;
      useAssemblyStore.getState().setPose(obj.name, {
        position: [obj.position.x, obj.position.y, obj.position.z],
        quaternion: [obj.quaternion.x, obj.quaternion.y, obj.quaternion.z, obj.quaternion.w],
      });
    });

    const raycaster = new THREE.Raycaster();

    function pick(clientX: number, clientY: number) {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const frustumWidth = (camera.right - camera.left) / camera.zoom;
      raycaster.params.Line = { threshold: (frustumWidth / rect.width) * 6 };

      const { parts: currentParts, pickEntity, selectPart } = useAssemblyStore.getState();
      const visuals = Array.from(visualsRef.current.values());

      const lineHits = raycaster.intersectObjects(visuals.map((v) => v.edgeLines), false);
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

      const faceHits = raycaster.intersectObjects(visuals.map((v) => v.mesh), false);
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
    }
    function onPointerUp(e: PointerEvent) {
      if (transform.dragging) return;
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

    const dom = renderer.domElement;
    dom.addEventListener("pointerdown", onPointerDown);
    dom.addEventListener("pointerup", onPointerUp);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("pointerup", onPointerUp);
      transform.dispose();
      orbit.dispose();
      renderer.dispose();
      container.removeChild(renderer.domElement);
      sceneRef.current = null;
      cameraRef.current = null;
      rendererRef.current = null;
      orbitRef.current = null;
      transformRef.current = null;
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
      visual.material.emissive.setHex(id === selectedPartId ? 0x27314d : 0x000000);
      visual.material.opacity = state.fixed ? 1 : 1;

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

  // --- transform gizmo attach/detach ---
  useEffect(() => {
    const transform = transformRef.current;
    if (!transform) return;
    transform.setMode(transformMode);
    const state = selectedPartId ? parts.get(selectedPartId) : undefined;
    const visual = selectedPartId ? visualsRef.current.get(selectedPartId) : undefined;
    if (!state || !visual || state.fixed) {
      transform.detach();
      return;
    }
    transform.attach(visual.group);
  }, [selectedPartId, transformMode, parts]);

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
    if (!fileName) return;
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
  }, [fileName]);

  return <div ref={containerRef} className="h-full w-full" />;
}

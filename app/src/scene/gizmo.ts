import * as THREE from "three";

export type GizmoMode = "translate" | "rotate";

interface AxisDef {
  axis: THREE.Vector3;
  color: number;
}

const AXES: AxisDef[] = [
  { axis: new THREE.Vector3(1, 0, 0), color: 0xe5484d },
  { axis: new THREE.Vector3(0, 1, 0), color: 0x3ecf8e },
  { axis: new THREE.Vector3(0, 0, 1), color: 0x4fa3ff },
];

const DESIRED_PIXEL_SIZE = 90; // roughly the on-screen radius/length of a handle, always
const HOVER_COLOR = 0xffd23f;

interface Handle {
  /** Invisible, generously-sized mesh used for raycasting/hit-testing. */
  mesh: THREE.Mesh;
  /** The mesh(es) actually painted on screen, recolored on hover. */
  visual: THREE.Mesh[];
  axis: THREE.Vector3;
  mode: GizmoMode;
  color: number;
}

/** A compact, purpose-built move/rotate gizmo for the (always-orthographic) CAD
 * viewport — arrows that move a part along one world axis, and rings that spin it
 * about one world axis, both drag-tracked by intersecting the mouse ray with a
 * plane (never by perspective-camera-only math), and both kept at a constant
 * on-screen size regardless of zoom, the way Blender/Shapr3D gizmos behave. */
export class Gizmo {
  readonly object = new THREE.Group();
  private mode: GizmoMode = "translate";
  private target: THREE.Object3D | null = null;
  private handles: Handle[] = [];
  private hovered: Handle | null = null;

  private dragging = false;
  private dragAxis = new THREE.Vector3();
  private dragMode: GizmoMode = "translate";
  private dragPlane = new THREE.Plane();
  private dragStartPoint = new THREE.Vector3();
  private dragStartPosition = new THREE.Vector3();
  private dragStartQuaternion = new THREE.Quaternion();
  private dragStartAngle = 0;
  private basisU = new THREE.Vector3();
  private basisV = new THREE.Vector3();

  constructor() {
    for (const { axis, color } of AXES) {
      this.handles.push(this.buildArrow(axis, color));
      this.handles.push(this.buildRing(axis, color));
    }
    this.object.visible = false;
    this.updateHandleVisibility();
  }

  private buildArrow(axis: THREE.Vector3, color: number): Handle {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);

    const shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.72, 10),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    shaft.position.copy(new THREE.Vector3(0, 0.36, 0).applyQuaternion(q));
    shaft.quaternion.copy(q);
    shaft.renderOrder = 10;

    const head = new THREE.Mesh(
      new THREE.ConeGeometry(0.08, 0.22, 14),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    head.position.copy(new THREE.Vector3(0, 0.72 + 0.11, 0).applyQuaternion(q));
    head.quaternion.copy(q);
    head.renderOrder = 10;

    // A single, generously-sized (invisible-looking, but not Object3D.visible=false —
    // that would also make it skip raycasting) mesh used for hit-testing.
    const hit = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.13, 1.05, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, depthTest: false }),
    );
    hit.position.copy(new THREE.Vector3(0, 0.5, 0).applyQuaternion(q));
    hit.quaternion.copy(q);

    this.object.add(shaft, head, hit);
    return { mesh: hit, visual: [shaft, head], axis: axis.clone(), mode: "translate", color };
  }

  private buildRing(axis: THREE.Vector3, color: number): Handle {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    const mesh = new THREE.Mesh(
      new THREE.TorusGeometry(0.9, 0.028, 8, 48),
      new THREE.MeshBasicMaterial({ color, depthTest: false }),
    );
    mesh.quaternion.copy(q);
    mesh.renderOrder = 10;

    // A fatter, transparent hit-test torus — easier to grab than the thin visible ring.
    const hit = new THREE.Mesh(
      new THREE.TorusGeometry(0.9, 0.09, 8, 48),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, depthTest: false }),
    );
    hit.quaternion.copy(q);

    this.object.add(mesh, hit);
    return { mesh: hit, visual: [mesh], axis: axis.clone(), mode: "rotate", color };
  }

  setMode(mode: GizmoMode): void {
    this.mode = mode;
    this.updateHandleVisibility();
  }

  private updateHandleVisibility(): void {
    for (const h of this.handles) {
      const show = h.mode === this.mode;
      for (const mesh of h.visual) mesh.visible = show;
    }
  }

  attach(target: THREE.Object3D | null): void {
    this.target = target;
    this.object.visible = !!target;
  }

  /** Keeps the gizmo positioned on its target and sized to a constant pixel
   * footprint. Call once per frame. The gizmo is intentionally NOT rotated to
   * match the target's own orientation — it always stays world-axis aligned,
   * which is what makes per-axis drags predictable. */
  syncToTarget(camera: THREE.OrthographicCamera, canvasHeightPx: number): void {
    if (!this.target) return;
    this.object.position.copy(this.target.position);
    const worldUnitsPerPixel = (camera.top - camera.bottom) / camera.zoom / Math.max(canvasHeightPx, 1);
    this.object.scale.setScalar(worldUnitsPerPixel * DESIRED_PIXEL_SIZE);
  }

  private handleMeshes(): THREE.Mesh[] {
    return this.handles.filter((h) => h.mode === this.mode).map((h) => h.mesh);
  }

  /** Highlights the handle under the ray (if any) and returns it, for hover feedback. */
  hoverTest(raycaster: THREE.Raycaster): Handle | null {
    if (!this.target) return this.setHovered(null);
    const hits = raycaster.intersectObjects(this.handleMeshes(), false);
    if (hits.length === 0) return this.setHovered(null);
    const handle = this.handles.find((h) => h.mesh === hits[0].object) ?? null;
    return this.setHovered(handle);
  }

  private setHovered(handle: Handle | null): Handle | null {
    if (this.hovered === handle) return handle;
    if (this.hovered) this.setHandleColor(this.hovered, this.hovered.color);
    if (handle) this.setHandleColor(handle, HOVER_COLOR);
    this.hovered = handle;
    return handle;
  }

  private setHandleColor(handle: Handle, hex: number): void {
    for (const mesh of handle.visual) (mesh.material as THREE.MeshBasicMaterial).color.setHex(hex);
  }

  /** Attempts to start a drag from a raycast; returns true if a handle was grabbed. */
  beginDrag(raycaster: THREE.Raycaster, camera: THREE.OrthographicCamera): boolean {
    if (!this.target) return false;
    const hits = raycaster.intersectObjects(this.handleMeshes(), false);
    if (hits.length === 0) return false;
    const handle = this.handles.find((h) => h.mesh === hits[0].object);
    if (!handle) return false;

    this.dragAxis.copy(handle.axis);
    this.dragMode = handle.mode;
    this.dragStartPosition.copy(this.target.position);
    this.dragStartQuaternion.copy(this.target.quaternion);

    if (this.dragMode === "translate") {
      const viewDir = new THREE.Vector3();
      camera.getWorldDirection(viewDir);
      let perp = new THREE.Vector3().crossVectors(this.dragAxis, viewDir);
      if (perp.lengthSq() < 1e-8) {
        const fallback = Math.abs(this.dragAxis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        perp = new THREE.Vector3().crossVectors(this.dragAxis, fallback);
      }
      const planeNormal = new THREE.Vector3().crossVectors(perp, this.dragAxis).normalize();
      this.dragPlane.setFromNormalAndCoplanarPoint(planeNormal, this.dragStartPosition);
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(this.dragPlane, hit)) return false;
      this.dragStartPoint.copy(hit);
    } else {
      this.dragPlane.setFromNormalAndCoplanarPoint(this.dragAxis, this.dragStartPosition);
      const hit = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(this.dragPlane, hit)) return false;
      const fallback = Math.abs(this.dragAxis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      this.basisU.crossVectors(fallback, this.dragAxis).normalize();
      this.basisV.crossVectors(this.dragAxis, this.basisU).normalize();
      const rel = hit.clone().sub(this.dragStartPosition);
      this.dragStartAngle = Math.atan2(rel.dot(this.basisV), rel.dot(this.basisU));
    }

    this.dragging = true;
    return true;
  }

  /** Advances the current drag; returns the new pose, or null if the ray misses. */
  updateDrag(raycaster: THREE.Raycaster): { position: THREE.Vector3; quaternion: THREE.Quaternion } | null {
    if (!this.dragging) return null;
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(this.dragPlane, hit)) return null;

    if (this.dragMode === "translate") {
      const delta = hit.clone().sub(this.dragStartPoint);
      const along = delta.dot(this.dragAxis);
      const position = this.dragStartPosition.clone().addScaledVector(this.dragAxis, along);
      return { position, quaternion: this.dragStartQuaternion.clone() };
    }

    const rel = hit.clone().sub(this.dragStartPosition);
    const angle = Math.atan2(rel.dot(this.basisV), rel.dot(this.basisU));
    const delta = angle - this.dragStartAngle;
    const deltaQuat = new THREE.Quaternion().setFromAxisAngle(this.dragAxis, delta);
    const quaternion = deltaQuat.multiply(this.dragStartQuaternion);
    return { position: this.dragStartPosition.clone(), quaternion };
  }

  endDrag(): void {
    this.dragging = false;
    this.setHovered(null);
  }

  dispose(): void {
    this.object.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        (obj.material as THREE.Material).dispose();
      }
    });
  }
}

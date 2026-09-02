import * as THREE from "three";
import type { ViewPreset } from "../assembly/store";

// Scene convention: Z-up, matching STEP/mechanical-CAD data as imported (unmodified).
const DIRECTIONS: Record<ViewPreset, { pos: THREE.Vector3; up: THREE.Vector3 }> = {
  iso: { pos: new THREE.Vector3(1, -1, 1), up: new THREE.Vector3(0, 0, 1) },
  front: { pos: new THREE.Vector3(0, -1, 0), up: new THREE.Vector3(0, 0, 1) },
  right: { pos: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1) },
  top: { pos: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0) },
};

export function applyViewPreset(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  target: THREE.Vector3,
  preset: ViewPreset,
  distance: number,
): void {
  const { pos, up } = DIRECTIONS[preset];
  camera.up.copy(up);
  camera.position.copy(pos).normalize().multiplyScalar(distance).add(target);
  camera.lookAt(target);
}

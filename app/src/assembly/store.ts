import * as THREE from "three";
import { create } from "zustand";
import type { AxisConstraint, AxisKey, EntityRef, FaceInfo, EdgeInfo, ImportedAssembly, ImportedPart, Pose, Quat, Vec3 } from "../occ/types";
import { countConnectedBodies, splitPartMesh } from "../occ/split";
import { applicableRelationTypes, resolveEntity, type Relation, type RelationType } from "./relations";
import { solveAssembly } from "./solver";

export type { AxisKey };

export interface PartState {
  part: ImportedPart;
  pose: Pose;
  fixed: boolean;
  visible: boolean;
  /** True when this part's mesh is actually several disconnected bodies bundled
   * together (common for STEP files that don't use proper assembly structure) —
   * enables the "Separar" action in the tree panel. */
  canSplit: boolean;
  /** Which Group (if any) this part belongs to — a part in a group is still a fully
   * independent object (its own pose, fixed state, relations); grouping only adds a
   * convenience: selecting the group and dragging any member moves every member by
   * the same rigid delta together. */
  groupId?: string;
  /** Per-axis lock: a locked axis is held at its current value across any interactive
   * edit (viewport drag, inspector field, group drag) — like "fijar" but for a single
   * coordinate instead of the whole part. Not enforced against relations inside the
   * solver, only at the interaction boundary (see `clampToAxisConstraints`). */
  axisLock?: Partial<Record<AxisKey, boolean>>;
  /** Per-axis [min, max] clamp (mm for x/y/z, degrees for rx/ry/rz), enforced the same
   * way as `axisLock`. */
  axisLimits?: Partial<Record<AxisKey, [number, number]>>;
  /** Overrides the palette color normally derived from this part's position in
   * `partOrder` — set via the tree panel's color picker (single or bulk). */
  color?: number;
  /** True for a virtual camera object rather than an imported physical part — reuses
   * every part mechanism (pose, drag, relations, groups) for free, since a camera is
   * just a part with an empty mesh (nothing to tessellate/render as a solid) plus a
   * field of view. Rendered as a wireframe frustum gizmo instead of a mesh; see
   * `cameraFov` and the "camera POV widget" in Viewport.tsx. */
  isCamera?: boolean;
  /** Only for `isCamera` parts: field of view in degrees. */
  cameraFov?: number;
}

/** A folder of parts that move together in the viewport (see PartState.groupId) —
 * purely an organizational/movement convenience, not a rigid assembly: each member
 * keeps its own relations and can still be selected and moved individually. */
export interface Group {
  id: string;
  name: string;
}

export type ViewPreset = "iso" | "front" | "top" | "right";
export type CameraProjection = "ortho" | "perspective";
export type ColorMode = "palette" | "gray";
export type TransformMode = "translate" | "rotate";
/** Which pivot a rotate-drag turns the selected part around: "part" spins it in place
 * about its own origin, "camera" orbits it (position and orientation both) about the
 * camera's look-at point, "free" is an unconstrained arcball around its own origin. */
export type RotatePivotMode = "part" | "camera" | "free";

/** A snapshot of the assembly's data (not UI/selection state) for undo/redo. Safe as a
 * shallow reference capture: every mutation in this store replaces `parts`/`partOrder`/
 * `relations` with new containers rather than mutating them in place. */
interface HistorySnapshot {
  parts: Map<string, PartState>;
  partOrder: string[];
  relations: Relation[];
  groups: Group[];
}

const MAX_HISTORY = 50;

/** A named snapshot of every part's pose, for the keyframe/playback feature — save the
 * assembly's current (already relation-satisfying) pose under a name, move things
 * around, save another, and play back an interpolated, constraint-respecting motion
 * between them. */
export interface Keyframe {
  id: string;
  name: string;
  poses: Map<string, Pose>;
}

const PLAYBACK_SEGMENT_MS = 1400;

interface AssemblyStore {
  /** One entry per file imported so far (imports add to the assembly, they don't replace it). */
  fileNames: string[];
  /** Bumped on every import so the viewport knows to re-frame the camera. */
  importVersion: number;
  parts: Map<string, PartState>;
  partOrder: string[];
  relations: Relation[];
  groups: Group[];
  history: HistorySnapshot[];
  future: HistorySnapshot[];
  keyframes: Keyframe[];
  isPlaying: boolean;

  selectedPartId: string | null;
  /** A selected group behaves like a selected part for viewport dragging (translate
   * only — see Viewport.tsx) — every member moves by the same delta, but stays fully
   * independent otherwise. Mutually exclusive with selectedPartId. */
  selectedGroupId: string | null;
  /** Ad-hoc multi-selection (Ctrl/Cmd-click in the tree, Shift-click in the viewport) —
   * independent of `selectedPartId`/`selectedGroupId`, which still drive the single-part
   * gizmo/inspector. Dragging any member (with 2+ selected) moves the whole selection
   * together the same way a Group does, without needing to actually create one; the
   * bulk action bar (color/group/fix/vincular) also reads from this set. */
  selectedPartIds: Set<string>;
  pickedEntities: EntityRef[];
  /** When set, the next entity pick replaces that side of the given relation
   * instead of feeding the normal two-pick "new relation" flow. */
  editingRelationSide: { relationId: string; side: "a" | "b" } | null;
  transformMode: TransformMode;
  rotatePivotMode: RotatePivotMode;
  requestedView: ViewPreset | null;
  cameraProjection: CameraProjection;
  /** Perspective camera field of view in degrees (0-90, Shapr3D-style "amount of
   * perspective" slider) — only meaningful while `cameraProjection === "perspective"`.
   * Changing it also dollies the camera to keep the currently-framed content the same
   * apparent size (see `switchCamera`/the fov-change effect in Viewport.tsx), so the
   * slider reads as "how much perspective distortion", not "zoom". */
  perspectiveFov: number;
  colorMode: ColorMode;
  loopPlayback: boolean;

  isSolving: boolean;
  lastSolve: { residualNorm: number; converged: boolean } | null;

  importAssembly: (assembly: ImportedAssembly) => void;
  clearAssembly: () => void;

  selectPart: (partId: string | null) => void;
  pickEntity: (ref: EntityRef) => void;
  clearPicked: () => void;

  /** Adds/removes one part from the ad-hoc multi-selection, independent of
   * selectedPartId/selectedGroupId. Used by both Ctrl/Cmd-click in the tree and
   * Shift-click in the viewport. */
  toggleMultiSelect: (partId: string) => void;
  clearMultiSelect: () => void;
  /** Bulk actions over the current multi-selection (or an explicit id list). */
  bulkSetFixed: (partIds: string[], fixed: boolean) => void;
  bulkSetColor: (partIds: string[], color: number) => void;
  setPartColor: (partId: string, color: number | undefined) => void;
  /** Welds every other selected part to the first one with a "rigid" relation (its
   * current relative offset captured as the constraint) — moving any of them from then
   * on moves all of them together, translation and rotation alike. Needs >=2 ids. */
  addRigidRelation: (partIds: string[]) => void;

  addCamera: () => void;
  setCameraFov: (partId: string, fov: number) => void;

  createGroup: (partIds: string[], name?: string) => void;
  ungroupParts: (groupId: string) => void;
  renameGroup: (groupId: string, name: string) => void;
  selectGroup: (groupId: string | null) => void;
  /** Real-time preview during a group drag: same mechanism as applyDragPreview, but
   * seeds several parts' poses at once (each member offset by the same rigid delta),
   * so the whole group tracks the cursor together while each member still resists
   * independently wherever its own relations constrain it. */
  applyGroupDragPreview: (patches: { partId: string; position?: Vec3; quaternion?: Quat }[]) => void;

  setPose: (partId: string, pose: Pose) => void;
  toggleFixed: (partId: string) => void;
  toggleVisible: (partId: string) => void;
  setTransformMode: (mode: TransformMode) => void;
  setRotatePivotMode: (mode: RotatePivotMode) => void;
  requestView: (view: ViewPreset) => void;
  consumeRequestedView: () => void;
  setCameraProjection: (projection: CameraProjection) => void;
  setPerspectiveFov: (fov: number) => void;
  setColorMode: (mode: ColorMode) => void;

  setAxisLock: (partId: string, axis: AxisKey, locked: boolean) => void;
  setAxisLimits: (partId: string, axis: AxisKey, min: number, max: number) => void;
  clearAxisLimits: (partId: string, axis: AxisKey) => void;

  /** Combines several parts' meshes into a single new part, baking each source part's
   * current relative pose into the merged geometry — a lightweight, non-boolean union
   * (the app doesn't retain OCCT shapes past import, so a true geometric fuse isn't
   * available at runtime). Meant for treating a cluster of parts as one object for
   * relation-authoring purposes in a large assembly. Any relation touching a merged
   * part is dropped, since its faces/edges no longer exist as separate entities. */
  mergeParts: (partIds: string[], name?: string) => void;

  addRelation: (type: RelationType, value: number) => void;
  removeRelation: (id: string) => void;
  toggleRelationFlip: (id: string) => void;
  setRelationValue: (id: string, value: number) => void;
  startEditRelationSide: (relationId: string, side: "a" | "b") => void;
  cancelEditRelationSide: () => void;

  splitPart: (partId: string) => void;
  deletePart: (partId: string) => void;

  setRelationAngleLimits: (id: string, angleMin: number, angleMax: number) => void;
  clearRelationAngleLimits: (id: string) => void;

  /** Records the current assembly data as an undo point — call right before a
   * mutation you want undoable (skip this for continuous updates like a live
   * drag; the caller pushes once per gesture instead). */
  pushHistorySnapshot: () => void;
  undo: () => void;
  redo: () => void;

  runSolve: () => void;
  /** Real-time preview during an interactive drag: re-solves with the dragged part's
   * pose seeded at the cursor's implied target (rather than its last-solved pose)
   * instead of its actual current one — the solve's minimum-norm correction back onto
   * the constraint manifold is exactly "move freely along whatever DOF the relations
   * leave open, resist the rest," applied every frame instead of only on release.
   * Skips restarts (fast, warm-started) and never touches history or `lastSolve`,
   * since it's not a discrete user action by itself. */
  applyDragPreview: (partId: string, patch: { position?: Vec3; quaternion?: Quat }) => void;

  saveKeyframe: (name?: string) => void;
  deleteKeyframe: (id: string) => void;
  renameKeyframe: (id: string, name: string) => void;
  /** Jumps the live assembly to a saved keyframe's pose (re-solved, so it still
   * respects every relation even if the assembly has changed since it was saved). */
  previewKeyframe: (id: string) => void;
  /** Replaces a keyframe's saved pose with the assembly's current one. */
  overwriteKeyframe: (id: string) => void;
  playKeyframes: () => void;
  stopPlayback: () => void;
  setLoopPlayback: (loop: boolean) => void;

  applicableRelationTypesForPicked: () => RelationType[];

  /** Serializes the whole project (parts/meshes, relations, groups, keyframes) to a
   * JSON string, for download — see ProjectPanel.tsx. */
  exportProject: () => string;
  /** Replaces the current assembly with one parsed from `exportProject`'s output.
   * Throws if the JSON doesn't look like a project file. */
  importProject: (json: string) => void;
}

let relationCounter = 0;
let importCounter = 0;
let keyframeCounter = 0;
let groupCounter = 0;
let cameraCounter = 0;
let playbackToken = 0;

/** Shared by the live-drag preview and keyframe playback: re-solve the assembly's
 * relations, but starting each free part not from its last-solved pose but from
 * `seed` where the seed provides one (falling back to its current pose otherwise).
 * Fixed parts always keep their real current pose regardless of `seed` — solveAssembly
 * passes every part's starting pose straight through as its output unless it's free,
 * so seeding a fixed part's pose would otherwise silently relocate it. */
/** Predicts the other side of a "rigid" relation's pose from one side's known pose,
 * using the same forward relationship the residual in relations.ts enforces
 * (B = A translated/rotated by rigidOffset). Used to seed a rigidly-linked partner with
 * its exact target *before* solving, rather than letting the solver discover it — see
 * `propagateRigidSeed`. */
function predictRigidPartner(relation: Relation, knownSide: "a" | "b", knownPose: Pose): Pose {
  const offset = relation.rigidOffset!;
  const offsetPos = new THREE.Vector3(...offset.position);
  const offsetQuat = new THREE.Quaternion(...offset.quaternion);
  const knownPos = new THREE.Vector3(...knownPose.position);
  const knownQuat = new THREE.Quaternion(...knownPose.quaternion);

  if (knownSide === "a") {
    const pos = offsetPos.clone().applyQuaternion(knownQuat).add(knownPos);
    const quat = knownQuat.clone().multiply(offsetQuat);
    return { position: [pos.x, pos.y, pos.z], quaternion: [quat.x, quat.y, quat.z, quat.w] };
  }
  const aQuat = knownQuat.clone().multiply(offsetQuat.clone().invert());
  const aPos = knownPos.clone().sub(offsetPos.applyQuaternion(aQuat));
  return { position: [aPos.x, aPos.y, aPos.z], quaternion: [aQuat.x, aQuat.y, aQuat.z, aQuat.w] };
}

/** Seeds every part transitively welded to `startId` via "rigid" relations with its
 * exact predicted pose, starting from `startId`'s own (already-decided) seed pose —
 * without this, dragging one side of a rigid link with *both* sides free leaves the
 * solver to split the correction between them however its regularization happens to
 * prefer (each free part's regularization pulls it toward staying put, and neither one
 * is privileged as "the one that was actually dragged"), instead of the linked part
 * following exactly. Mirrors how a Group/multi-select drag already seeds every member
 * explicitly for the same reason. Skips (but doesn't stop propagation past) a fixed
 * partner, since a fixed part's pose is never up for negotiation. */
function propagateRigidSeed(parts: Map<string, PartState>, relations: Relation[], startId: string, startPose: Pose, seed: Map<string, Pose>) {
  seed.set(startId, startPose);
  const queue: [string, Pose][] = [[startId, startPose]];
  while (queue.length > 0) {
    const [id, pose] = queue.shift()!;
    for (const rel of relations) {
      if (rel.type !== "rigid") continue;
      const isA = rel.a.partId === id;
      const isB = rel.b.partId === id;
      if (!isA && !isB) continue;
      const otherId = isA ? rel.b.partId : rel.a.partId;
      if (seed.has(otherId)) continue;
      const otherEntry = parts.get(otherId);
      if (!otherEntry || otherEntry.fixed) continue;
      const predicted = predictRigidPartner(rel, isA ? "a" : "b", pose);
      // Re-clamp the rigid link's prediction against the partner's OWN axis locks/
      // limits — otherwise a locked partner's *seed* (the solver's warm-start point,
      // used as the reference every axis-lock residual holds against) would already
      // sit at the un-clamped, rigid-predicted position by the time the solver ever
      // runs, so the lock would end up "holding" the wrong (drifted) value instead of
      // rejecting the drift. Matches the same clamp already applied to the directly-
      // dragged part's own patch, just extended to whoever the rigid link propagates to.
      const clamped = clampToAxisConstraints(otherEntry, predicted) as Pose;
      seed.set(otherId, clamped);
      queue.push([otherId, clamped]);
    }
  }
}

/** Sparse per-part axis locks/limits, in the shape the solver wants (see
 * SolveInput.axisConstraints) — built fresh from live PartState on every solve call
 * since axisLock/axisLimits can change between calls. Only parts that actually have a
 * lock or limit get an entry, and `undefined` (not an empty Map) is returned when
 * nothing is constrained so solveAssembly's callers can skip the extra residual work. */
function buildAxisConstraints(parts: Map<string, PartState>): Map<string, AxisConstraint> | undefined {
  let map: Map<string, AxisConstraint> | undefined;
  for (const [id, st] of parts) {
    if (!st.axisLock && !st.axisLimits) continue;
    if (!map) map = new Map();
    map.set(id, { lock: st.axisLock, limits: st.axisLimits });
  }
  return map;
}

function posesEqual(a: Pose, b: Pose): boolean {
  return (
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2] &&
    a.quaternion[0] === b.quaternion[0] &&
    a.quaternion[1] === b.quaternion[1] &&
    a.quaternion[2] === b.quaternion[2] &&
    a.quaternion[3] === b.quaternion[3]
  );
}

/** Applies a solve result's poses onto `parts`, preserving each PartState's object
 * identity for any part whose pose didn't actually change (a fixed part, or a free one
 * untouched by every relation) — a solve result always covers every part, so without
 * this every single PartState gets rewrapped in a new object on every call, which hands
 * every panel subscribed to `parts` (TreePanel, RelationsPanel, InspectorPanel) a
 * reason to re-render ALL of it on every animation frame during keyframe playback or a
 * live drag, even the rows for parts that never moved. */
function applyPosesToParts(parts: Map<string, PartState>, poses: Map<string, Pose>): Map<string, PartState> {
  const next = new Map(parts);
  for (const [id, pose] of poses) {
    const e = next.get(id);
    if (e && !posesEqual(e.pose, pose)) next.set(id, { ...e, pose });
  }
  return next;
}

function solveFromSeed(parts: Map<string, PartState>, relations: Relation[], seed: Map<string, Pose>) {
  const partMap = new Map<string, ImportedPart>();
  const poses = new Map<string, Pose>();
  const fixedIds = new Set<string>();
  for (const [id, st] of parts) {
    partMap.set(id, st.part);
    poses.set(id, st.fixed ? st.pose : (seed.get(id) ?? st.pose));
    if (st.fixed) fixedIds.add(id);
  }
  const axisConstraints = buildAxisConstraints(parts);
  return solveAssembly({ parts: partMap, poses, fixedPartIds: fixedIds, relations, restarts: 0, axisConstraints });
}

const POSITION_AXES: AxisKey[] = ["x", "y", "z"];
const ROTATION_AXES: AxisKey[] = ["rx", "ry", "rz"];

/** Enforces a part's per-axis lock/limits on a proposed pose patch, at the interaction
 * boundary — a locked axis is snapped back to its current value, a limited axis is
 * clamped into range, everything else passes through unchanged. Shared by every path
 * that can move a part interactively (single-part drag, group drag, inspector edits),
 * so the constraint holds however the part is being moved. */
function clampToAxisConstraints(entry: PartState, patch: { position?: Vec3; quaternion?: Quat }): { position?: Vec3; quaternion?: Quat } {
  const { axisLock, axisLimits } = entry;
  if (!axisLock && !axisLimits) return patch;

  let position = patch.position;
  if (position) {
    const cur = entry.pose.position;
    position = [...position] as Vec3;
    POSITION_AXES.forEach((axis, i) => {
      if (axisLock?.[axis]) {
        position![i] = cur[i];
        return;
      }
      const range = axisLimits?.[axis];
      if (range) position![i] = THREE.MathUtils.clamp(position![i], range[0], range[1]);
    });
  }

  let quaternion = patch.quaternion;
  if (quaternion && (ROTATION_AXES.some((a) => axisLock?.[a]) || ROTATION_AXES.some((a) => axisLimits?.[a]))) {
    const curEuler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...entry.pose.quaternion), "XYZ");
    const nextEuler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...quaternion), "XYZ");
    const curDeg = [THREE.MathUtils.radToDeg(curEuler.x), THREE.MathUtils.radToDeg(curEuler.y), THREE.MathUtils.radToDeg(curEuler.z)];
    const nextDeg = [THREE.MathUtils.radToDeg(nextEuler.x), THREE.MathUtils.radToDeg(nextEuler.y), THREE.MathUtils.radToDeg(nextEuler.z)];
    ROTATION_AXES.forEach((axis, i) => {
      if (axisLock?.[axis]) {
        nextDeg[i] = curDeg[i];
        return;
      }
      const range = axisLimits?.[axis];
      if (range) nextDeg[i] = THREE.MathUtils.clamp(nextDeg[i], range[0], range[1]);
    });
    const q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(THREE.MathUtils.degToRad(nextDeg[0]), THREE.MathUtils.degToRad(nextDeg[1]), THREE.MathUtils.degToRad(nextDeg[2]), "XYZ"),
    );
    quaternion = [q.x, q.y, q.z, q.w];
  }

  return { position, quaternion };
}

// --- project export/import -------------------------------------------------------
// Typed arrays (PartMesh's positions/normals/indices/triangleFaceId) don't round-trip
// through JSON.stringify/parse as arrays (they'd serialize as {"0":1,"1":2,...} objects
// and need explicit reconstruction), so the on-disk shape converts them to plain
// number[] and back explicitly rather than relying on default (de)serialization.

const PROJECT_FILE_VERSION = 1;

interface SerializedMesh {
  positions: number[];
  normals: number[];
  indices: number[];
  triangleFaceId: number[];
  faces: FaceInfo[];
  edges: EdgeInfo[];
}

interface SerializedPartState extends Omit<PartState, "part"> {
  part: { id: string; name: string; initialPose: Pose; mesh: SerializedMesh };
}

interface ProjectFile {
  version: number;
  fileNames: string[];
  partOrder: string[];
  parts: [string, SerializedPartState][];
  relations: Relation[];
  groups: Group[];
  keyframes: { id: string; name: string; poses: [string, Pose][] }[];
}

function serializePartState(st: PartState): SerializedPartState {
  const mesh = st.part.mesh;
  return {
    ...st,
    part: {
      id: st.part.id,
      name: st.part.name,
      initialPose: st.part.initialPose,
      mesh: {
        positions: Array.from(mesh.positions),
        normals: Array.from(mesh.normals),
        indices: Array.from(mesh.indices),
        triangleFaceId: Array.from(mesh.triangleFaceId),
        faces: mesh.faces,
        edges: mesh.edges,
      },
    },
  };
}

function deserializePartState(st: SerializedPartState): PartState {
  const mesh = st.part.mesh;
  return {
    ...st,
    part: {
      id: st.part.id,
      name: st.part.name,
      initialPose: st.part.initialPose,
      mesh: {
        positions: Float32Array.from(mesh.positions),
        normals: Float32Array.from(mesh.normals),
        indices: Uint32Array.from(mesh.indices),
        triangleFaceId: Int32Array.from(mesh.triangleFaceId),
        faces: mesh.faces,
        edges: mesh.edges,
      },
    },
  };
}

/** Scans a batch of ids for the highest `N` matched by `pattern` (e.g. /^rel-(\d+)$/)
 * and returns max(current, N+1) — used after importing a project so any counter used
 * to mint new ids picks up after whatever the imported file already contains. */
function bumpCounter(ids: string[], pattern: RegExp, current: number): number {
  let max = current;
  for (const id of ids) {
    const m = pattern.exec(id);
    if (m) max = Math.max(max, Number(m[1]) + 1);
  }
  return max;
}

function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const position = new THREE.Vector3(...a.position).lerp(new THREE.Vector3(...b.position), t);
  const quaternion = new THREE.Quaternion(...a.quaternion).slerp(new THREE.Quaternion(...b.quaternion), t);
  return {
    position: [position.x, position.y, position.z],
    quaternion: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
  };
}

export const useAssemblyStore = create<AssemblyStore>((set, get) => ({
  fileNames: [],
  importVersion: 0,
  parts: new Map(),
  partOrder: [],
  relations: [],
  groups: [],
  history: [],
  future: [],
  keyframes: [],
  isPlaying: false,

  selectedPartId: null,
  selectedGroupId: null,
  selectedPartIds: new Set(),
  pickedEntities: [],
  editingRelationSide: null,
  transformMode: "translate",
  rotatePivotMode: "part",
  requestedView: "iso",
  cameraProjection: "ortho",
  perspectiveFov: 50,
  colorMode: "palette",
  loopPlayback: false,

  isSolving: false,
  lastSolve: null,

  importAssembly: (assembly: ImportedAssembly) => {
    get().pushHistorySnapshot();
    const importId = importCounter++;
    const parts = new Map(get().parts);
    const newIds: string[] = [];
    assembly.parts.forEach((part) => {
      // Prefix ids so a second (or third...) import never collides with parts
      // already in the scene — imports add to the assembly, they don't replace it.
      const id = `imp${importId}-${part.id}`;
      newIds.push(id);
      parts.set(id, {
        part: { ...part, id },
        pose: { position: [...part.initialPose.position], quaternion: [...part.initialPose.quaternion] },
        fixed: false,
        visible: true,
        canSplit: countConnectedBodies(part.mesh) > 1,
      });
    });
    set({
      fileNames: [...get().fileNames, assembly.fileName],
      importVersion: get().importVersion + 1,
      parts,
      partOrder: [...get().partOrder, ...newIds],
      pickedEntities: [],
    });
  },

  clearAssembly: () => {
    get().pushHistorySnapshot();
    set({
      fileNames: [],
      parts: new Map(),
      partOrder: [],
      relations: [],
      groups: [],
      keyframes: [],
      selectedPartId: null,
      selectedGroupId: null,
      pickedEntities: [],
      lastSolve: null,
    });
  },

  selectPart: (partId) => set({ selectedPartId: partId, selectedGroupId: null, pickedEntities: [] }),

  toggleMultiSelect: (partId) => {
    const next = new Set(get().selectedPartIds);
    if (next.has(partId)) next.delete(partId);
    else next.add(partId);
    set({ selectedPartIds: next });
  },
  clearMultiSelect: () => set({ selectedPartIds: new Set() }),

  bulkSetFixed: (partIds, fixed) => {
    const ids = partIds.filter((id) => get().parts.has(id));
    if (ids.length === 0) return;
    get().pushHistorySnapshot();
    const parts = new Map(get().parts);
    for (const id of ids) {
      const entry = parts.get(id);
      if (entry) parts.set(id, { ...entry, fixed });
    }
    set({ parts });
  },

  bulkSetColor: (partIds, color) => {
    const ids = partIds.filter((id) => get().parts.has(id));
    if (ids.length === 0) return;
    get().pushHistorySnapshot();
    const parts = new Map(get().parts);
    for (const id of ids) {
      const entry = parts.get(id);
      if (entry) parts.set(id, { ...entry, color });
    }
    set({ parts });
  },

  setPartColor: (partId, color) => {
    const entry = get().parts.get(partId);
    if (!entry) return;
    get().pushHistorySnapshot();
    const parts = new Map(get().parts);
    parts.set(partId, { ...entry, color });
    set({ parts });
  },

  addRigidRelation: (partIds) => {
    const ids = partIds.filter((id) => get().parts.has(id));
    if (ids.length < 2) return;
    get().pushHistorySnapshot();
    const parts = get().parts;
    const anchorId = ids[0];
    const anchor = parts.get(anchorId)!;
    const anchorPos = new THREE.Vector3(...anchor.pose.position);
    const anchorQuat = new THREE.Quaternion(...anchor.pose.quaternion);
    const anchorQuatInv = anchorQuat.clone().invert();

    const newRelations: Relation[] = [];
    for (const id of ids.slice(1)) {
      const entry = parts.get(id)!;
      const pos = new THREE.Vector3(...entry.pose.position);
      const quat = new THREE.Quaternion(...entry.pose.quaternion);
      // B's pose relative to A's, captured now — the offset the "rigid" residual holds
      // fixed from here on (see relationResiduals in relations.ts).
      const relPos = pos.clone().sub(anchorPos).applyQuaternion(anchorQuatInv);
      const relQuat = anchorQuatInv.clone().multiply(quat);
      newRelations.push({
        id: `rel-${relationCounter++}`,
        type: "rigid",
        a: { partId: anchorId, kind: "part", id: 0 },
        b: { partId: id, kind: "part", id: 0 },
        value: 0,
        rigidOffset: {
          position: [relPos.x, relPos.y, relPos.z],
          quaternion: [relQuat.x, relQuat.y, relQuat.z, relQuat.w],
        },
      });
    }
    set({ relations: [...get().relations, ...newRelations] });
    get().runSolve();
  },

  addCamera: () => {
    get().pushHistorySnapshot();
    const id = `cam-${cameraCounter++}`;

    // Aim the new camera at wherever the rest of the assembly actually is (a rough
    // position-only bounding sphere of the non-camera parts, not a real mesh bounds —
    // just enough to land the camera in view instead of off in an arbitrary void the
    // user has to go hunt for) — defaulting to a generic ISO-ish offset when the
    // assembly is empty or is only other cameras.
    const realParts = Array.from(get().parts.values()).filter((p) => !p.isCamera);
    const center = new THREE.Vector3();
    let radius = 80;
    if (realParts.length > 0) {
      for (const p of realParts) center.add(new THREE.Vector3(...p.pose.position));
      center.divideScalar(realParts.length);
      radius = Math.max(80, ...realParts.map((p) => center.distanceTo(new THREE.Vector3(...p.pose.position)) + 40));
    }
    const distance = radius * 1.8;
    const position = center.clone().add(new THREE.Vector3(-distance * 0.7, -distance * 0.7, distance * 0.5));
    // Point it at the assembly's center by default — same lookAt-derived quaternion
    // three.js's own Object3D.lookAt would produce, so the frustum gizmo and POV widget
    // both start aimed at roughly where the assembly is instead of an arbitrary
    // identity rotation.
    const m = new THREE.Matrix4().lookAt(position, center, new THREE.Vector3(0, 0, 1));
    const quat = new THREE.Quaternion().setFromRotationMatrix(m);
    const pose: Pose = { position: [position.x, position.y, position.z], quaternion: [quat.x, quat.y, quat.z, quat.w] };
    const emptyMesh = {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      triangleFaceId: new Int32Array(0),
      faces: [],
      edges: [],
    };
    const parts = new Map(get().parts);
    parts.set(id, {
      part: { id, name: `Cámara ${cameraCounter}`, mesh: emptyMesh, initialPose: pose },
      pose,
      fixed: false,
      visible: true,
      canSplit: false,
      isCamera: true,
      cameraFov: 50,
    });
    set({ parts, partOrder: [...get().partOrder, id], selectedPartId: id, selectedGroupId: null });
  },

  setCameraFov: (partId, fov) => {
    const entry = get().parts.get(partId);
    if (!entry || !entry.isCamera) return;
    const parts = new Map(get().parts);
    parts.set(partId, { ...entry, cameraFov: THREE.MathUtils.clamp(fov, 1, 170) });
    set({ parts });
  },

  createGroup: (partIds, name) => {
    const ids = partIds.filter((id) => get().parts.has(id));
    if (ids.length < 2) return;
    get().pushHistorySnapshot();
    const groupId = `grp-${groupCounter++}`;
    const parts = new Map(get().parts);
    for (const id of ids) {
      const entry = parts.get(id);
      if (entry) parts.set(id, { ...entry, groupId });
    }
    set({
      parts,
      groups: [...get().groups, { id: groupId, name: name?.trim() || `Grupo ${get().groups.length + 1}` }],
      selectedPartId: null,
      selectedGroupId: groupId,
      pickedEntities: [],
    });
  },

  ungroupParts: (groupId) => {
    get().pushHistorySnapshot();
    const parts = new Map(get().parts);
    for (const [id, entry] of parts) {
      if (entry.groupId === groupId) parts.set(id, { ...entry, groupId: undefined });
    }
    set({
      parts,
      groups: get().groups.filter((g) => g.id !== groupId),
      selectedGroupId: get().selectedGroupId === groupId ? null : get().selectedGroupId,
    });
  },

  renameGroup: (groupId, name) => {
    set({ groups: get().groups.map((g) => (g.id === groupId ? { ...g, name: name.trim() || g.name } : g)) });
  },

  selectGroup: (groupId) => set({ selectedGroupId: groupId, selectedPartId: null, pickedEntities: [] }),

  applyGroupDragPreview: (patches) => {
    const { parts, relations } = get();
    const seed = new Map<string, Pose>();
    for (const { partId, position, quaternion } of patches) {
      const entry = parts.get(partId);
      if (!entry) continue;
      const constrained = clampToAxisConstraints(entry, { position, quaternion });
      const pose: Pose = { position: constrained.position ?? entry.pose.position, quaternion: constrained.quaternion ?? entry.pose.quaternion };
      // Also seeds anything rigidly welded to this member but outside the dragged
      // group/multi-selection itself — see propagateRigidSeed.
      propagateRigidSeed(parts, relations, partId, pose, seed);
    }
    const result = solveFromSeed(parts, relations, seed);
    set({ parts: applyPosesToParts(parts, result.poses) });
  },

  pickEntity: (ref) => {
    const editing = get().editingRelationSide;
    if (editing) {
      get().pushHistorySnapshot();
      const relations = get().relations.map((r) =>
        r.id === editing.relationId ? { ...r, [editing.side]: ref } : r,
      );
      set({ relations, editingRelationSide: null, selectedPartId: ref.partId });
      get().runSolve();
      return;
    }
    const current = get().pickedEntities;
    const already = current.findIndex((e) => e.partId === ref.partId && e.kind === ref.kind && e.id === ref.id);
    if (already !== -1) {
      set({ pickedEntities: current.filter((_, i) => i !== already) });
      return;
    }
    const next = [...current, ref];
    if (next.length > 2) next.shift();
    set({ pickedEntities: next, selectedPartId: ref.partId });
  },

  clearPicked: () => set({ pickedEntities: [] }),

  setPose: (partId, pose) => {
    const parts = new Map(get().parts);
    const entry = parts.get(partId);
    if (!entry) return;
    parts.set(partId, { ...entry, pose });
    set({ parts });
  },

  toggleFixed: (partId) => {
    const entry = get().parts.get(partId);
    if (!entry) return;
    get().pushHistorySnapshot();
    const parts = new Map(get().parts);
    parts.set(partId, { ...entry, fixed: !entry.fixed });
    set({ parts });
  },

  toggleVisible: (partId) => {
    const entry = get().parts.get(partId);
    if (!entry) return;
    get().pushHistorySnapshot();
    const parts = new Map(get().parts);
    parts.set(partId, { ...entry, visible: !entry.visible });
    set({ parts });
  },

  setTransformMode: (mode) => set({ transformMode: mode }),
  setRotatePivotMode: (mode) => set({ rotatePivotMode: mode }),
  requestView: (view) => set({ requestedView: view }),
  consumeRequestedView: () => set({ requestedView: null }),
  setCameraProjection: (projection) => set({ cameraProjection: projection }),
  setPerspectiveFov: (fov) => set({ perspectiveFov: THREE.MathUtils.clamp(fov, 1, 90) }),
  setColorMode: (mode) => set({ colorMode: mode }),

  setAxisLock: (partId, axis, locked) => {
    const entry = get().parts.get(partId);
    if (!entry) return;
    get().pushHistorySnapshot();
    const parts = new Map(get().parts);
    parts.set(partId, { ...entry, axisLock: { ...entry.axisLock, [axis]: locked } });
    set({ parts });
  },

  setAxisLimits: (partId, axis, min, max) => {
    const entry = get().parts.get(partId);
    if (!entry) return;
    get().pushHistorySnapshot();
    const parts = new Map(get().parts);
    const updated: PartState = { ...entry, axisLimits: { ...entry.axisLimits, [axis]: [min, max] } };
    // If the part's current pose already falls outside the new range, snap it in now —
    // otherwise the limit would only start biting on the *next* interactive edit.
    const constrained = clampToAxisConstraints(updated, updated.pose);
    updated.pose = { position: constrained.position ?? updated.pose.position, quaternion: constrained.quaternion ?? updated.pose.quaternion };
    parts.set(partId, updated);
    set({ parts });
    get().runSolve();
  },

  clearAxisLimits: (partId, axis) => {
    const entry = get().parts.get(partId);
    if (!entry) return;
    get().pushHistorySnapshot();
    const parts = new Map(get().parts);
    const axisLimits = { ...entry.axisLimits };
    delete axisLimits[axis];
    parts.set(partId, { ...entry, axisLimits });
    set({ parts });
  },

  mergeParts: (partIds, name) => {
    const { parts: allParts } = get();
    const ids = partIds.filter((id) => allParts.has(id));
    if (ids.length < 2) return;
    get().pushHistorySnapshot();

    const first = allParts.get(ids[0])!;
    const basePos = new THREE.Vector3(...first.pose.position);
    const baseQuat = new THREE.Quaternion(...first.pose.quaternion);
    const baseQuatInv = baseQuat.clone().invert();

    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const triangleFaceId: number[] = [];
    const faces: PartState["part"]["mesh"]["faces"] = [];
    const edges: PartState["part"]["mesh"]["edges"] = [];
    let faceIdCounter = 0;
    let edgeIdCounter = 0;
    let vertexBase = 0;

    const transformPoint = (p: Vec3, pos: THREE.Vector3, quat: THREE.Quaternion): Vec3 => {
      // World position under `pos`/`quat`, then re-expressed relative to the merged
      // part's own frame (the first source part's pose) — exactly mirrors how a
      // group's members keep their real-world placement when treated as one object.
      const world = new THREE.Vector3(...p).applyQuaternion(quat).add(pos);
      const local = world.sub(basePos).applyQuaternion(baseQuatInv);
      return [local.x, local.y, local.z];
    };
    const transformDir = (d: Vec3, quat: THREE.Quaternion): Vec3 => {
      const world = new THREE.Vector3(...d).applyQuaternion(quat);
      const local = world.applyQuaternion(baseQuatInv);
      return [local.x, local.y, local.z];
    };

    for (const id of ids) {
      const entry = allParts.get(id)!;
      const pos = new THREE.Vector3(...entry.pose.position);
      const quat = new THREE.Quaternion(...entry.pose.quaternion);
      const mesh = entry.part.mesh;
      const vCount = mesh.positions.length / 3;
      for (let i = 0; i < vCount; i++) {
        const [x, y, z] = transformPoint([mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]], pos, quat);
        positions.push(x, y, z);
        const [nx, ny, nz] = transformDir([mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]], quat);
        normals.push(nx, ny, nz);
      }
      for (let i = 0; i < mesh.indices.length; i++) indices.push(mesh.indices[i] + vertexBase);
      const faceIdMap = new Map<number, number>();
      for (const f of mesh.faces) {
        const newId = faceIdCounter++;
        faceIdMap.set(f.id, newId);
        faces.push({
          ...f,
          id: newId,
          point: transformPoint(f.point, pos, quat),
          normal: transformDir(f.normal, quat),
          axisOrigin: f.axisOrigin ? transformPoint(f.axisOrigin, pos, quat) : undefined,
        });
      }
      for (let i = 0; i < mesh.triangleFaceId.length; i++) {
        triangleFaceId.push(faceIdMap.get(mesh.triangleFaceId[i]) ?? -1);
      }
      for (const e of mesh.edges) {
        edges.push({
          ...e,
          id: edgeIdCounter++,
          point: transformPoint(e.point, pos, quat),
          direction: transformDir(e.direction, quat),
          axisOrigin: e.axisOrigin ? transformPoint(e.axisOrigin, pos, quat) : undefined,
          a: transformPoint(e.a, pos, quat),
          b: transformPoint(e.b, pos, quat),
          polyline: e.polyline.map((p) => transformPoint(p, pos, quat)),
        });
      }
      vertexBase += vCount;
    }

    const mergedId = `merge-${importCounter++}`;
    const mergedPose: Pose = { position: [...first.pose.position], quaternion: [...first.pose.quaternion] };
    const parts = new Map(allParts);
    for (const id of ids) parts.delete(id);
    parts.set(mergedId, {
      part: {
        id: mergedId,
        name: name?.trim() || `${first.part.name} (unida)`,
        mesh: {
          positions: new Float32Array(positions),
          normals: new Float32Array(normals),
          indices: new Uint32Array(indices),
          triangleFaceId: new Int32Array(triangleFaceId),
          faces,
          edges,
        },
        initialPose: mergedPose,
      },
      pose: mergedPose,
      fixed: ids.some((id) => allParts.get(id)!.fixed),
      visible: true,
      canSplit: false,
    });

    const idSet = new Set(ids);
    set({
      parts,
      partOrder: [...get().partOrder.filter((id) => !idSet.has(id)), mergedId],
      relations: get().relations.filter((r) => !idSet.has(r.a.partId) && !idSet.has(r.b.partId)),
      selectedPartId: mergedId,
      selectedGroupId: null,
      pickedEntities: [],
    });
    get().runSolve();
  },

  addRelation: (type, value) => {
    const [a, b] = get().pickedEntities;
    if (!a || !b) return;
    get().pushHistorySnapshot();
    const relation: Relation = { id: `rel-${relationCounter++}`, type, a, b, value };
    set({ relations: [...get().relations, relation], pickedEntities: [] });
    get().runSolve();
  },

  removeRelation: (id) => {
    get().pushHistorySnapshot();
    set({ relations: get().relations.filter((r) => r.id !== id) });
    get().runSolve();
  },

  toggleRelationFlip: (id) => {
    get().pushHistorySnapshot();
    set({ relations: get().relations.map((r) => (r.id === id ? { ...r, flip: !r.flip } : r)) });
    get().runSolve();
  },

  setRelationValue: (id, value) => {
    get().pushHistorySnapshot();
    set({ relations: get().relations.map((r) => (r.id === id ? { ...r, value } : r)) });
    get().runSolve();
  },

  startEditRelationSide: (relationId, side) =>
    set({ editingRelationSide: { relationId, side }, pickedEntities: [] }),

  cancelEditRelationSide: () => set({ editingRelationSide: null }),

  splitPart: (partId) => {
    const state = get().parts.get(partId);
    if (!state) return;
    const result = splitPartMesh(state.part.mesh);
    if (!result) return;
    get().pushHistorySnapshot();

    const basePos = new THREE.Vector3(...state.pose.position);
    const baseQuat = new THREE.Quaternion(...state.pose.quaternion);

    const parts = new Map(get().parts);
    parts.delete(partId);
    const partOrder = get().partOrder.filter((id) => id !== partId);

    const newIds: string[] = [];
    result.forEach(({ mesh, origin }, i) => {
      const id = `${partId}-split${i + 1}`;
      const worldOffset = new THREE.Vector3(...origin).applyQuaternion(baseQuat);
      const position = basePos.clone().add(worldOffset).toArray() as Vec3;
      const pose: Pose = { position, quaternion: [...state.pose.quaternion] };
      parts.set(id, {
        part: { id, name: `${state.part.name}.${i + 1}`, mesh, initialPose: pose },
        pose,
        fixed: state.fixed,
        visible: true,
        canSplit: false,
        groupId: state.groupId,
      });
      newIds.push(id);
    });

    set({
      parts,
      partOrder: [...partOrder, ...newIds],
      relations: get().relations.filter((r) => r.a.partId !== partId && r.b.partId !== partId),
      selectedPartId: null,
      pickedEntities: [],
    });
    get().runSolve();
  },

  deletePart: (partId) => {
    const entry = get().parts.get(partId);
    if (!entry) return;
    get().pushHistorySnapshot();
    const parts = new Map(get().parts);
    parts.delete(partId);
    const { selectedPartId, pickedEntities } = get();
    set({
      parts,
      partOrder: get().partOrder.filter((id) => id !== partId),
      relations: get().relations.filter((r) => r.a.partId !== partId && r.b.partId !== partId),
      selectedPartId: selectedPartId === partId ? null : selectedPartId,
      pickedEntities: pickedEntities.filter((e) => e.partId !== partId),
    });
    get().runSolve();
  },

  setRelationAngleLimits: (id, angleMin, angleMax) => {
    const relation = get().relations.find((r) => r.id === id);
    if (!relation) return;
    get().pushHistorySnapshot();
    const partA = get().parts.get(relation.a.partId);
    const partB = get().parts.get(relation.b.partId);
    if (!partA || !partB) return;
    set({
      relations: get().relations.map((r) =>
        r.id === id
          ? { ...r, angleMin, angleMax, refQuatA: [...partA.pose.quaternion], refQuatB: [...partB.pose.quaternion] }
          : r,
      ),
    });
    get().runSolve();
  },

  clearRelationAngleLimits: (id) => {
    get().pushHistorySnapshot();
    set({
      relations: get().relations.map((r) => {
        if (r.id !== id) return r;
        const next = { ...r };
        delete next.angleMin;
        delete next.angleMax;
        delete next.refQuatA;
        delete next.refQuatB;
        return next;
      }),
    });
    get().runSolve();
  },

  runSolve: () => {
    const { parts, relations } = get();
    if (parts.size === 0) return;
    set({ isSolving: true });

    const partMap = new Map<string, ImportedPart>();
    const poses = new Map<string, Pose>();
    const fixedIds = new Set<string>();
    for (const [id, st] of parts) {
      partMap.set(id, st.part);
      poses.set(id, st.pose);
      if (st.fixed) fixedIds.add(id);
    }

    const axisConstraints = buildAxisConstraints(parts);
    const result = solveAssembly({ parts: partMap, poses, fixedPartIds: fixedIds, relations, axisConstraints });

    set({
      parts: applyPosesToParts(parts, result.poses),
      isSolving: false,
      lastSolve: { residualNorm: result.residualNorm, converged: result.converged },
    });
  },

  applyDragPreview: (partId, patch) => {
    const { parts, relations } = get();
    const entry = parts.get(partId);
    if (!entry) return;
    const constrained = clampToAxisConstraints(entry, patch);
    const seedPose: Pose = { position: constrained.position ?? entry.pose.position, quaternion: constrained.quaternion ?? entry.pose.quaternion };
    const seed = new Map<string, Pose>();
    propagateRigidSeed(parts, relations, partId, seedPose, seed);
    const result = solveFromSeed(parts, relations, seed);
    set({ parts: applyPosesToParts(parts, result.poses) });
  },

  saveKeyframe: (name) => {
    const { parts, keyframes } = get();
    if (parts.size === 0) return;
    get().pushHistorySnapshot();
    const poses = new Map<string, Pose>();
    for (const [id, st] of parts) poses.set(id, st.pose);
    const keyframe: Keyframe = { id: `kf-${keyframeCounter++}`, name: name?.trim() || `Pose ${keyframes.length + 1}`, poses };
    set({ keyframes: [...keyframes, keyframe] });
  },

  deleteKeyframe: (id) => {
    get().pushHistorySnapshot();
    set({ keyframes: get().keyframes.filter((k) => k.id !== id) });
  },

  renameKeyframe: (id, name) => {
    set({ keyframes: get().keyframes.map((k) => (k.id === id ? { ...k, name: name.trim() || k.name } : k)) });
  },

  previewKeyframe: (id) => {
    const { keyframes, parts, relations, isPlaying } = get();
    if (isPlaying) return;
    const kf = keyframes.find((k) => k.id === id);
    if (!kf) return;
    get().pushHistorySnapshot();
    const result = solveFromSeed(parts, relations, kf.poses);
    set({
      parts: applyPosesToParts(parts, result.poses),
      selectedPartId: null,
      pickedEntities: [],
      lastSolve: { residualNorm: result.residualNorm, converged: result.converged },
    });
  },

  overwriteKeyframe: (id) => {
    const { parts, keyframes } = get();
    if (parts.size === 0) return;
    const poses = new Map<string, Pose>();
    for (const [pid, st] of parts) poses.set(pid, st.pose);
    set({ keyframes: keyframes.map((k) => (k.id === id ? { ...k, poses } : k)) });
  },

  playKeyframes: () => {
    const { keyframes, isPlaying } = get();
    if (keyframes.length < 2 || isPlaying) return;
    const token = ++playbackToken;
    set({ isPlaying: true });

    function applySeed(seed: Map<string, Pose>) {
      const { parts, relations } = get();
      const result = solveFromSeed(parts, relations, seed);
      set({ parts: applyPosesToParts(parts, result.poses) });
    }

    function runSegment(from: Map<string, Pose>, to: Map<string, Pose>): Promise<void> {
      return new Promise((resolve) => {
        const start = performance.now();
        const ids = new Set([...from.keys(), ...to.keys()]);
        function tick(now: number) {
          if (token !== playbackToken) {
            resolve();
            return;
          }
          const t = Math.min(1, (now - start) / PLAYBACK_SEGMENT_MS);
          const seed = new Map<string, Pose>();
          for (const id of ids) {
            const a = from.get(id);
            const b = to.get(id);
            if (a && b) seed.set(id, lerpPose(a, b, t));
            else if (b) seed.set(id, b);
          }
          applySeed(seed);
          if (t < 1) requestAnimationFrame(tick);
          else resolve();
        }
        requestAnimationFrame(tick);
      });
    }

    (async () => {
      do {
        for (let i = 0; i < keyframes.length - 1; i++) {
          if (token !== playbackToken) break;
          await runSegment(keyframes[i].poses, keyframes[i + 1].poses);
        }
      } while (token === playbackToken && get().loopPlayback);
      if (token === playbackToken) {
        set({ isPlaying: false });
        get().runSolve();
      }
    })();
  },

  setLoopPlayback: (loop) => set({ loopPlayback: loop }),

  stopPlayback: () => {
    playbackToken++;
    set({ isPlaying: false });
  },

  pushHistorySnapshot: () => {
    const { parts, partOrder, relations, groups, history } = get();
    const trimmed = history.length >= MAX_HISTORY ? history.slice(history.length - MAX_HISTORY + 1) : history;
    set({ history: [...trimmed, { parts, partOrder, relations, groups }], future: [] });
  },

  undo: () => {
    const { history, future, parts, partOrder, relations, groups } = get();
    const previous = history[history.length - 1];
    if (!previous) return;
    set({
      parts: previous.parts,
      partOrder: previous.partOrder,
      relations: previous.relations,
      groups: previous.groups,
      history: history.slice(0, -1),
      future: [...future, { parts, partOrder, relations, groups }],
      selectedPartId: null,
      selectedGroupId: null,
      pickedEntities: [],
      editingRelationSide: null,
    });
  },

  redo: () => {
    const { history, future, parts, partOrder, relations, groups } = get();
    const next = future[future.length - 1];
    if (!next) return;
    set({
      parts: next.parts,
      partOrder: next.partOrder,
      relations: next.relations,
      groups: next.groups,
      future: future.slice(0, -1),
      history: [...history, { parts, partOrder, relations, groups }],
      selectedPartId: null,
      selectedGroupId: null,
      pickedEntities: [],
      editingRelationSide: null,
    });
  },

  applicableRelationTypesForPicked: () => {
    const { parts, pickedEntities } = get();
    const [a, b] = pickedEntities;
    if (!a || !b) return [];
    const partA = parts.get(a.partId);
    const partB = parts.get(b.partId);
    if (!partA || !partB) return [];
    const ra = resolveEntity(partA.part, a, partA.pose);
    const rb = resolveEntity(partB.part, b, partB.pose);
    if (!ra || !rb) return [];
    return applicableRelationTypes(ra, rb);
  },

  exportProject: () => {
    const { fileNames, partOrder, parts, relations, groups, keyframes } = get();
    const file: ProjectFile = {
      version: PROJECT_FILE_VERSION,
      fileNames,
      partOrder,
      parts: Array.from(parts.entries()).map(([id, st]) => [id, serializePartState(st)]),
      relations,
      groups,
      keyframes: keyframes.map((k) => ({ id: k.id, name: k.name, poses: Array.from(k.poses.entries()) })),
    };
    return JSON.stringify(file);
  },

  importProject: (json) => {
    let file: ProjectFile;
    try {
      file = JSON.parse(json);
    } catch {
      throw new Error("El archivo no es JSON válido.");
    }
    if (!file || file.version !== PROJECT_FILE_VERSION || !Array.isArray(file.parts)) {
      throw new Error("No es un archivo de proyecto reconocible.");
    }
    get().pushHistorySnapshot();

    const parts = new Map<string, PartState>(file.parts.map(([id, st]) => [id, deserializePartState(st)]));
    const keyframes: Keyframe[] = file.keyframes.map((k) => ({ id: k.id, name: k.name, poses: new Map(k.poses) }));

    // Bump every id counter past whatever this file contains, so anything created
    // *after* importing never collides with an id the import just brought in.
    importCounter = bumpCounter(file.partOrder, /^imp(\d+)-/, importCounter);
    relationCounter = bumpCounter(file.relations.map((r) => r.id), /^rel-(\d+)$/, relationCounter);
    groupCounter = bumpCounter(file.groups.map((g) => g.id), /^grp-(\d+)$/, groupCounter);
    cameraCounter = bumpCounter(Array.from(parts.keys()), /^cam-(\d+)$/, cameraCounter);
    keyframeCounter = bumpCounter(file.keyframes.map((k) => k.id), /^kf-(\d+)$/, keyframeCounter);

    set({
      fileNames: file.fileNames,
      partOrder: file.partOrder,
      parts,
      relations: file.relations,
      groups: file.groups,
      keyframes,
      selectedPartId: null,
      selectedGroupId: null,
      selectedPartIds: new Set(),
      pickedEntities: [],
      editingRelationSide: null,
      history: [],
      future: [],
      lastSolve: null,
    });
  },
}));

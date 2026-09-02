import * as THREE from "three";
import { create } from "zustand";
import type { EntityRef, ImportedAssembly, ImportedPart, Pose, Quat, Vec3 } from "../occ/types";
import { countConnectedBodies, splitPartMesh } from "../occ/split";
import { applicableRelationTypes, resolveEntity, type Relation, type RelationType } from "./relations";
import { solveAssembly } from "./solver";

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
  pickedEntities: EntityRef[];
  /** When set, the next entity pick replaces that side of the given relation
   * instead of feeding the normal two-pick "new relation" flow. */
  editingRelationSide: { relationId: string; side: "a" | "b" } | null;
  transformMode: TransformMode;
  rotatePivotMode: RotatePivotMode;
  requestedView: ViewPreset | null;
  cameraProjection: CameraProjection;

  isSolving: boolean;
  lastSolve: { residualNorm: number; converged: boolean } | null;

  importAssembly: (assembly: ImportedAssembly) => void;
  clearAssembly: () => void;

  selectPart: (partId: string | null) => void;
  pickEntity: (ref: EntityRef) => void;
  clearPicked: () => void;

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

  applicableRelationTypesForPicked: () => RelationType[];
}

let relationCounter = 0;
let importCounter = 0;
let keyframeCounter = 0;
let groupCounter = 0;
let playbackToken = 0;

/** Shared by the live-drag preview and keyframe playback: re-solve the assembly's
 * relations, but starting each free part not from its last-solved pose but from
 * `seed` where the seed provides one (falling back to its current pose otherwise).
 * Fixed parts always keep their real current pose regardless of `seed` — solveAssembly
 * passes every part's starting pose straight through as its output unless it's free,
 * so seeding a fixed part's pose would otherwise silently relocate it. */
function solveFromSeed(parts: Map<string, PartState>, relations: Relation[], seed: Map<string, Pose>) {
  const partMap = new Map<string, ImportedPart>();
  const poses = new Map<string, Pose>();
  const fixedIds = new Set<string>();
  for (const [id, st] of parts) {
    partMap.set(id, st.part);
    poses.set(id, st.fixed ? st.pose : (seed.get(id) ?? st.pose));
    if (st.fixed) fixedIds.add(id);
  }
  return solveAssembly({ parts: partMap, poses, fixedPartIds: fixedIds, relations, restarts: 0 });
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
  pickedEntities: [],
  editingRelationSide: null,
  transformMode: "translate",
  rotatePivotMode: "part",
  requestedView: "iso",
  cameraProjection: "ortho",

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
      seed.set(partId, { position: position ?? entry.pose.position, quaternion: quaternion ?? entry.pose.quaternion });
    }
    const result = solveFromSeed(parts, relations, seed);
    const nextParts = new Map(parts);
    for (const [id, pose] of result.poses) {
      const e = nextParts.get(id);
      if (e) nextParts.set(id, { ...e, pose });
    }
    set({ parts: nextParts });
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

    const result = solveAssembly({ parts: partMap, poses, fixedPartIds: fixedIds, relations });

    const nextParts = new Map(parts);
    for (const [id, pose] of result.poses) {
      const entry = nextParts.get(id);
      if (entry) nextParts.set(id, { ...entry, pose });
    }
    set({
      parts: nextParts,
      isSolving: false,
      lastSolve: { residualNorm: result.residualNorm, converged: result.converged },
    });
  },

  applyDragPreview: (partId, patch) => {
    const { parts, relations } = get();
    const entry = parts.get(partId);
    if (!entry) return;
    const seedPose: Pose = { position: patch.position ?? entry.pose.position, quaternion: patch.quaternion ?? entry.pose.quaternion };
    const result = solveFromSeed(parts, relations, new Map([[partId, seedPose]]));

    const nextParts = new Map(parts);
    for (const [id, pose] of result.poses) {
      const e = nextParts.get(id);
      if (e) nextParts.set(id, { ...e, pose });
    }
    set({ parts: nextParts });
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
    const nextParts = new Map(parts);
    for (const [pid, pose] of result.poses) {
      const e = nextParts.get(pid);
      if (e) nextParts.set(pid, { ...e, pose });
    }
    set({
      parts: nextParts,
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
      const nextParts = new Map(parts);
      for (const [id, pose] of result.poses) {
        const e = nextParts.get(id);
        if (e) nextParts.set(id, { ...e, pose });
      }
      set({ parts: nextParts });
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
      for (let i = 0; i < keyframes.length - 1; i++) {
        if (token !== playbackToken) break;
        await runSegment(keyframes[i].poses, keyframes[i + 1].poses);
      }
      if (token === playbackToken) {
        set({ isPlaying: false });
        get().runSolve();
      }
    })();
  },

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
}));

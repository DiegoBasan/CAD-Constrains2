import * as THREE from "three";
import { create } from "zustand";
import type { EntityRef, ImportedAssembly, ImportedPart, Pose, Vec3 } from "../occ/types";
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
}

export type ViewPreset = "iso" | "front" | "top" | "right";
export type TransformMode = "translate" | "rotate";

/** A snapshot of the assembly's data (not UI/selection state) for undo/redo. Safe as a
 * shallow reference capture: every mutation in this store replaces `parts`/`partOrder`/
 * `relations` with new containers rather than mutating them in place. */
interface HistorySnapshot {
  parts: Map<string, PartState>;
  partOrder: string[];
  relations: Relation[];
}

const MAX_HISTORY = 50;

interface AssemblyStore {
  /** One entry per file imported so far (imports add to the assembly, they don't replace it). */
  fileNames: string[];
  /** Bumped on every import so the viewport knows to re-frame the camera. */
  importVersion: number;
  parts: Map<string, PartState>;
  partOrder: string[];
  relations: Relation[];
  history: HistorySnapshot[];
  future: HistorySnapshot[];

  selectedPartId: string | null;
  pickedEntities: EntityRef[];
  /** When set, the next entity pick replaces that side of the given relation
   * instead of feeding the normal two-pick "new relation" flow. */
  editingRelationSide: { relationId: string; side: "a" | "b" } | null;
  transformMode: TransformMode;
  requestedView: ViewPreset | null;

  isSolving: boolean;
  lastSolve: { residualNorm: number; converged: boolean } | null;

  importAssembly: (assembly: ImportedAssembly) => void;
  clearAssembly: () => void;

  selectPart: (partId: string | null) => void;
  pickEntity: (ref: EntityRef) => void;
  clearPicked: () => void;

  setPose: (partId: string, pose: Pose) => void;
  toggleFixed: (partId: string) => void;
  toggleVisible: (partId: string) => void;
  setTransformMode: (mode: TransformMode) => void;
  requestView: (view: ViewPreset) => void;
  consumeRequestedView: () => void;

  addRelation: (type: RelationType, value: number) => void;
  removeRelation: (id: string) => void;
  toggleRelationFlip: (id: string) => void;
  setRelationValue: (id: string, value: number) => void;
  startEditRelationSide: (relationId: string, side: "a" | "b") => void;
  cancelEditRelationSide: () => void;

  splitPart: (partId: string) => void;

  /** Records the current assembly data as an undo point — call right before a
   * mutation you want undoable (skip this for continuous updates like a live
   * drag; the caller pushes once per gesture instead). */
  pushHistorySnapshot: () => void;
  undo: () => void;
  redo: () => void;

  runSolve: () => void;

  applicableRelationTypesForPicked: () => RelationType[];
}

let relationCounter = 0;
let importCounter = 0;

export const useAssemblyStore = create<AssemblyStore>((set, get) => ({
  fileNames: [],
  importVersion: 0,
  parts: new Map(),
  partOrder: [],
  relations: [],
  history: [],
  future: [],

  selectedPartId: null,
  pickedEntities: [],
  editingRelationSide: null,
  transformMode: "translate",
  requestedView: "iso",

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
      selectedPartId: null,
      pickedEntities: [],
      lastSolve: null,
    });
  },

  selectPart: (partId) => set({ selectedPartId: partId, pickedEntities: [] }),

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
  requestView: (view) => set({ requestedView: view }),
  consumeRequestedView: () => set({ requestedView: null }),

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

  pushHistorySnapshot: () => {
    const { parts, partOrder, relations, history } = get();
    const trimmed = history.length >= MAX_HISTORY ? history.slice(history.length - MAX_HISTORY + 1) : history;
    set({ history: [...trimmed, { parts, partOrder, relations }], future: [] });
  },

  undo: () => {
    const { history, future, parts, partOrder, relations } = get();
    const previous = history[history.length - 1];
    if (!previous) return;
    set({
      parts: previous.parts,
      partOrder: previous.partOrder,
      relations: previous.relations,
      history: history.slice(0, -1),
      future: [...future, { parts, partOrder, relations }],
      selectedPartId: null,
      pickedEntities: [],
      editingRelationSide: null,
    });
  },

  redo: () => {
    const { history, future, parts, partOrder, relations } = get();
    const next = future[future.length - 1];
    if (!next) return;
    set({
      parts: next.parts,
      partOrder: next.partOrder,
      relations: next.relations,
      future: future.slice(0, -1),
      history: [...history, { parts, partOrder, relations }],
      selectedPartId: null,
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

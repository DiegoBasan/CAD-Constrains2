import { create } from "zustand";
import type { EntityRef, ImportedAssembly, ImportedPart, Pose } from "../occ/types";
import { applicableRelationTypes, resolveEntity, type Relation, type RelationType } from "./relations";
import { solveAssembly } from "./solver";

export interface PartState {
  part: ImportedPart;
  pose: Pose;
  fixed: boolean;
  visible: boolean;
}

export type ViewPreset = "iso" | "front" | "top" | "right";
export type TransformMode = "translate" | "rotate";

interface AssemblyStore {
  /** One entry per file imported so far (imports add to the assembly, they don't replace it). */
  fileNames: string[];
  /** Bumped on every import so the viewport knows to re-frame the camera. */
  importVersion: number;
  parts: Map<string, PartState>;
  partOrder: string[];
  relations: Relation[];

  selectedPartId: string | null;
  pickedEntities: EntityRef[];
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

  selectedPartId: null,
  pickedEntities: [],
  transformMode: "translate",
  requestedView: "iso",

  isSolving: false,
  lastSolve: null,

  importAssembly: (assembly: ImportedAssembly) => {
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

  clearAssembly: () =>
    set({
      fileNames: [],
      parts: new Map(),
      partOrder: [],
      relations: [],
      selectedPartId: null,
      pickedEntities: [],
      lastSolve: null,
    }),

  selectPart: (partId) => set({ selectedPartId: partId, pickedEntities: [] }),

  pickEntity: (ref) => {
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
    const parts = new Map(get().parts);
    const entry = parts.get(partId);
    if (!entry) return;
    parts.set(partId, { ...entry, fixed: !entry.fixed });
    set({ parts });
  },

  toggleVisible: (partId) => {
    const parts = new Map(get().parts);
    const entry = parts.get(partId);
    if (!entry) return;
    parts.set(partId, { ...entry, visible: !entry.visible });
    set({ parts });
  },

  setTransformMode: (mode) => set({ transformMode: mode }),
  requestView: (view) => set({ requestedView: view }),
  consumeRequestedView: () => set({ requestedView: null }),

  addRelation: (type, value) => {
    const [a, b] = get().pickedEntities;
    if (!a || !b) return;
    const relation: Relation = { id: `rel-${relationCounter++}`, type, a, b, value };
    set({ relations: [...get().relations, relation], pickedEntities: [] });
    get().runSolve();
  },

  removeRelation: (id) => {
    set({ relations: get().relations.filter((r) => r.id !== id) });
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

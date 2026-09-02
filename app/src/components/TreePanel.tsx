import { memo, useCallback, useState } from "react";
import { useAssemblyStore, type PartState } from "../assembly/store";
import { partColor } from "../scene/colors";

function hexToNumber(hex: string): number {
  return parseInt(hex.slice(1), 16);
}
function numberToHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function TreePanel() {
  const partOrder = useAssemblyStore((s) => s.partOrder);
  const parts = useAssemblyStore((s) => s.parts);
  const groups = useAssemblyStore((s) => s.groups);
  const selectedPartId = useAssemblyStore((s) => s.selectedPartId);
  const selectedGroupId = useAssemblyStore((s) => s.selectedGroupId);
  const selectedPartIds = useAssemblyStore((s) => s.selectedPartIds);
  const selectPart = useAssemblyStore((s) => s.selectPart);
  const selectGroup = useAssemblyStore((s) => s.selectGroup);
  const toggleMultiSelect = useAssemblyStore((s) => s.toggleMultiSelect);
  const clearMultiSelect = useAssemblyStore((s) => s.clearMultiSelect);
  const createGroup = useAssemblyStore((s) => s.createGroup);
  const ungroupParts = useAssemblyStore((s) => s.ungroupParts);
  const renameGroup = useAssemblyStore((s) => s.renameGroup);
  const mergeParts = useAssemblyStore((s) => s.mergeParts);
  const addRigidRelation = useAssemblyStore((s) => s.addRigidRelation);
  const toggleFixed = useAssemblyStore((s) => s.toggleFixed);
  const toggleVisible = useAssemblyStore((s) => s.toggleVisible);
  const splitPart = useAssemblyStore((s) => s.splitPart);
  const bulkSetFixed = useAssemblyStore((s) => s.bulkSetFixed);
  const bulkSetColor = useAssemblyStore((s) => s.bulkSetColor);
  const addCamera = useAssemblyStore((s) => s.addCamera);

  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  // Stabilized with useCallback (deps limited to what selection logic actually reads)
  // so its identity survives a pose-only re-render — PartRow is memoized specifically
  // so a part untouched by the live pose updates during keyframe playback can skip
  // re-rendering entirely, which only works if every prop it's given, callbacks
  // included, stays referentially stable across those updates.
  const handlePartClick = useCallback(
    (e: React.MouseEvent, id: string) => {
      if (e.ctrlKey || e.metaKey) {
        // A plain click only drives store selection, not multi-select — so the first
        // Ctrl-click of a gesture needs to seed the set with whatever's already singly
        // selected, or a lone Ctrl-click on a second part would never reach 2.
        if (selectedPartIds.size === 0 && selectedPartId) toggleMultiSelect(selectedPartId);
        toggleMultiSelect(id);
        return;
      }
      clearMultiSelect();
      selectPart(selectedPartId === id ? null : id);
    },
    [selectedPartIds, selectedPartId, toggleMultiSelect, clearMultiSelect, selectPart],
  );

  function handleGroupHeaderClick(groupId: string) {
    clearMultiSelect();
    selectGroup(selectedGroupId === groupId ? null : groupId);
  }

  function startRename(groupId: string, currentName: string) {
    setEditingGroupId(groupId);
    setEditingName(currentName);
  }

  function commitRename(groupId: string) {
    renameGroup(groupId, editingName);
    setEditingGroupId(null);
  }

  const renderedGroups = new Set<string>();
  const multiCount = selectedPartIds.size;

  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}
      >
        <span>Piezas</span>
        <button
          onClick={addCamera}
          title="Agregar un objeto cámara (invisible; se ve como un widget POV flotante)"
          className="rounded px-2 py-0.5 text-[11px] font-medium normal-case hover:opacity-80"
          style={{ color: "var(--text-dim)" }}
        >
          📷 + Cámara
        </button>
      </div>

      {multiCount >= 2 && (
        <div
          className="flex flex-col gap-1.5 border-b px-3 py-2"
          style={{ borderColor: "var(--border)", background: "var(--bg-2)" }}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => {
                createGroup(Array.from(selectedPartIds));
                clearMultiSelect();
              }}
              title="Cada pieza sigue siendo independiente, pero se mueven juntas al arrastrar cualquier miembro"
              className="rounded px-2 py-0.5 text-[11px] font-medium hover:opacity-80"
              style={{ background: "var(--accent-bg)", color: "var(--accent)" }}
            >
              Agrupar ({multiCount})
            </button>
            <button
              onClick={() => {
                mergeParts(Array.from(selectedPartIds));
                clearMultiSelect();
              }}
              title="Combina las piezas seleccionadas en una sola (une sus mallas, ya no se pueden mover por separado)"
              className="rounded px-2 py-0.5 text-[11px] font-medium hover:opacity-80"
              style={{ background: "var(--bg-3)", color: "var(--text-bright)", border: "1px solid var(--border-strong)" }}
            >
              Unir ({multiCount})
            </button>
            <button
              onClick={() => addRigidRelation(Array.from(selectedPartIds))}
              title="Relación rígida: donde sea que estén ahora quedan vinculadas — mover cualquiera mueve a todas igual en posición y rotación"
              className="rounded px-2 py-0.5 text-[11px] font-medium hover:opacity-80"
              style={{ background: "var(--bg-3)", color: "var(--text-bright)", border: "1px solid var(--border-strong)" }}
            >
              Vincular ({multiCount})
            </button>
          </div>
          <div className="flex items-center gap-3 text-[11px]" style={{ color: "var(--text-dim)" }}>
            <button onClick={() => bulkSetFixed(Array.from(selectedPartIds), true)} className="hover:opacity-80">
              🔒 Fijar
            </button>
            <button onClick={() => bulkSetFixed(Array.from(selectedPartIds), false)} className="hover:opacity-80">
              🔓 Liberar
            </button>
            <label className="flex items-center gap-1.5">
              Color
              <input
                type="color"
                onChange={(e) => bulkSetColor(Array.from(selectedPartIds), hexToNumber(e.target.value))}
                className="h-4 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
              />
            </label>
            <button onClick={clearMultiSelect} className="ml-auto underline hover:opacity-80">
              Limpiar
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {partOrder.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: "var(--text-dim)" }}>
            Importa un archivo STEP para empezar.
          </div>
        )}
        {partOrder.map((id, index) => {
          const state = parts.get(id);
          if (!state) return null;

          if (state.groupId) {
            if (renderedGroups.has(state.groupId)) return null;
            renderedGroups.add(state.groupId);
            const group = groups.find((g) => g.id === state.groupId);
            if (!group) return null;
            const memberIds = partOrder.filter((pid) => parts.get(pid)?.groupId === group.id);
            const groupSelected = group.id === selectedGroupId;
            return (
              <div key={group.id}>
                <div
                  onClick={() => handleGroupHeaderClick(group.id)}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px] font-medium"
                  style={{
                    background: groupSelected ? "var(--accent-bg)" : "transparent",
                    color: groupSelected ? "var(--text-bright)" : "var(--text)",
                  }}
                >
                  <span className="shrink-0">📁</span>
                  {editingGroupId === group.id ? (
                    <input
                      autoFocus
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => commitRename(group.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(group.id);
                        if (e.key === "Escape") setEditingGroupId(null);
                      }}
                      className="flex-1 rounded border px-1 py-0.5 text-[12px]"
                      style={{ background: "var(--bg-1)", borderColor: "var(--border)", color: "var(--text-bright)" }}
                    />
                  ) : (
                    <span
                      className="flex-1 truncate"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(group.id, group.name);
                      }}
                      title="Doble clic para renombrar"
                    >
                      {group.name}
                    </span>
                  )}
                  <button
                    title="Desagrupar — cada pieza vuelve a moverse de forma independiente"
                    onClick={(e) => {
                      e.stopPropagation();
                      ungroupParts(group.id);
                    }}
                    className="shrink-0 rounded px-1 text-[11px] hover:opacity-80"
                    style={{ color: "var(--text-dim)" }}
                  >
                    ✕
                  </button>
                </div>
                {memberIds.map((memberId) => {
                  const memberState = parts.get(memberId);
                  if (!memberState) return null;
                  const memberIndex = partOrder.indexOf(memberId);
                  return (
                    <PartRow
                      key={memberId}
                      id={memberId}
                      index={memberIndex}
                      state={memberState}
                      selected={memberId === selectedPartId}
                      multiSelected={selectedPartIds.has(memberId)}
                      indent
                      onClick={handlePartClick}
                      onToggleFixed={toggleFixed}
                      onToggleVisible={toggleVisible}
                      onSplit={splitPart}
                    />
                  );
                })}
              </div>
            );
          }

          return (
            <PartRow
              key={id}
              id={id}
              index={index}
              state={state}
              selected={id === selectedPartId}
              multiSelected={selectedPartIds.has(id)}
              onClick={handlePartClick}
              onToggleFixed={toggleFixed}
              onToggleVisible={toggleVisible}
              onSplit={splitPart}
            />
          );
        })}
      </div>
    </div>
  );
}

// Memoized so a part left untouched by a solve (see applyPosesToParts in store.ts,
// which preserves PartState object identity for anything that didn't actually move)
// skips re-rendering when only OTHER parts' poses changed — matters most during
// keyframe playback, which updates `parts` on every animation frame.
const PartRow = memo(function PartRow({
  id,
  index,
  state,
  selected,
  multiSelected,
  indent,
  onClick,
  onToggleFixed,
  onToggleVisible,
  onSplit,
}: {
  id: string;
  index: number;
  state: PartState | undefined;
  selected: boolean;
  multiSelected: boolean;
  indent?: boolean;
  onClick: (e: React.MouseEvent, id: string) => void;
  onToggleFixed: (id: string) => void;
  onToggleVisible: (id: string) => void;
  onSplit: (id: string) => void;
}) {
  if (!state) return null;
  const color = numberToHex(state.color ?? partColor(index));
  return (
    <div
      onClick={(e) => onClick(e, id)}
      className="flex cursor-pointer items-center gap-2 py-1.5 pr-3 text-[12px]"
      style={{
        paddingLeft: indent ? "1.75rem" : "0.75rem",
        background: selected ? "var(--accent-bg)" : multiSelected ? "var(--bg-2)" : "transparent",
        color: selected ? "var(--text-bright)" : "var(--text)",
        outline: multiSelected ? "1px solid var(--accent-dim)" : "none",
        outlineOffset: "-1px",
      }}
    >
      {state.isCamera ? (
        <span className="shrink-0 text-[12px]">📷</span>
      ) : (
        <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />
      )}
      <span className="flex-1 truncate">{state.part.name}</span>
      {state.canSplit && (
        <button
          title="Esta pieza tiene varios cuerpos desconectados — separar en piezas independientes"
          onClick={(e) => {
            e.stopPropagation();
            onSplit(id);
          }}
          className="shrink-0 rounded px-1 text-[11px] hover:opacity-80"
          style={{ color: "var(--text-dim)" }}
        >
          ✂
        </button>
      )}
      <button
        title={state.fixed ? "Pieza fija — clic para liberarla" : "Pieza libre — clic para fijarla"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFixed(id);
        }}
        className="rounded px-1.5 py-0.5 text-[12px] hover:opacity-80"
        style={{
          background: state.fixed ? "var(--accent-bg)" : "transparent",
          color: state.fixed ? "var(--warn)" : "var(--text-dim)",
        }}
      >
        {state.fixed ? "🔒" : "🔓"}
      </button>
      <button
        title={state.visible ? "Ocultar" : "Mostrar"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleVisible(id);
        }}
        className="rounded px-1 text-[11px] hover:opacity-80"
        style={{ color: state.visible ? "var(--text-dim)" : "var(--danger)" }}
      >
        {state.visible ? "👁" : "🚫"}
      </button>
    </div>
  );
});

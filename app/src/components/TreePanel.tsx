import { useAssemblyStore } from "../assembly/store";
import { partColor } from "../scene/colors";

export function TreePanel() {
  const partOrder = useAssemblyStore((s) => s.partOrder);
  const parts = useAssemblyStore((s) => s.parts);
  const selectedPartId = useAssemblyStore((s) => s.selectedPartId);
  const selectPart = useAssemblyStore((s) => s.selectPart);
  const toggleFixed = useAssemblyStore((s) => s.toggleFixed);
  const toggleVisible = useAssemblyStore((s) => s.toggleVisible);

  return (
    <div className="flex h-full flex-col">
      <div
        className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}
      >
        Piezas
      </div>
      <div className="flex-1 overflow-y-auto">
        {partOrder.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px]" style={{ color: "var(--text-dim)" }}>
            Importa un archivo STEP para empezar.
          </div>
        )}
        {partOrder.map((id, index) => {
          const state = parts.get(id);
          if (!state) return null;
          const selected = id === selectedPartId;
          const color = `#${partColor(index).toString(16).padStart(6, "0")}`;
          return (
            <div
              key={id}
              onClick={() => selectPart(selected ? null : id)}
              className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[12px]"
              style={{
                background: selected ? "var(--accent-bg)" : "transparent",
                color: selected ? "var(--text-bright)" : "var(--text)",
              }}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: color }} />
              <span className="flex-1 truncate">{state.part.name}</span>
              {state.fixed && (
                <span title="Fija" className="text-[10px]" style={{ color: "var(--warn)" }}>
                  🔒
                </span>
              )}
              <button
                title={state.fixed ? "Liberar pieza" : "Fijar pieza"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFixed(id);
                }}
                className="rounded px-1 text-[11px] hover:opacity-80"
                style={{ color: "var(--text-dim)" }}
              >
                {state.fixed ? "Fijo" : "Libre"}
              </button>
              <button
                title={state.visible ? "Ocultar" : "Mostrar"}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleVisible(id);
                }}
                className="rounded px-1 text-[11px] hover:opacity-80"
                style={{ color: state.visible ? "var(--text-dim)" : "var(--danger)" }}
              >
                {state.visible ? "👁" : "🚫"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { useAssemblyStore, type ViewPreset, type TransformMode } from "../assembly/store";
import { ImportButton } from "./ImportButton";

const VIEWS: { id: ViewPreset; label: string }[] = [
  { id: "iso", label: "ISO" },
  { id: "front", label: "Frontal" },
  { id: "top", label: "Superior" },
  { id: "right", label: "Derecha" },
];

const MODES: { id: TransformMode; label: string }[] = [
  { id: "translate", label: "Mover" },
  { id: "rotate", label: "Rotar" },
];

function ToolbarButton({
  active,
  onClick,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors"
      style={{
        background: active ? "var(--accent-bg)" : "transparent",
        color: active ? "var(--accent)" : "var(--text-dim)",
        border: `1px solid ${active ? "var(--accent-dim)" : "transparent"}`,
      }}
    >
      {children}
    </button>
  );
}

export function Toolbar() {
  const requestView = useAssemblyStore((s) => s.requestView);
  const transformMode = useAssemblyStore((s) => s.transformMode);
  const setTransformMode = useAssemblyStore((s) => s.setTransformMode);
  const fileNames = useAssemblyStore((s) => s.fileNames);
  const partCount = useAssemblyStore((s) => s.partOrder.length);

  return (
    <div
      className="flex h-12 shrink-0 items-center gap-4 border-b px-3"
      style={{ borderColor: "var(--border)", background: "var(--bg-1)" }}
    >
      <div className="flex items-center gap-2 pr-3" style={{ borderRight: "1px solid var(--border)" }}>
        <span className="text-[13px] font-semibold" style={{ color: "var(--text-bright)" }}>
          CAD Assembler
        </span>
      </div>

      <ImportButton />

      <div className="flex items-center gap-1 pl-1" style={{ borderLeft: "1px solid var(--border)" }}>
        {VIEWS.map((v) => (
          <ToolbarButton key={v.id} onClick={() => requestView(v.id)}>
            {v.label}
          </ToolbarButton>
        ))}
      </div>

      <div className="flex items-center gap-1 pl-3" style={{ borderLeft: "1px solid var(--border)" }}>
        {MODES.map((m) => (
          <ToolbarButton key={m.id} active={transformMode === m.id} onClick={() => setTransformMode(m.id)}>
            {m.label}
          </ToolbarButton>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-2 text-[11px]" style={{ color: "var(--text-dim)" }}>
        {fileNames.length > 0 && (
          <span>
            {fileNames.length === 1 ? fileNames[0] : `${fileNames.length} archivos`} · {partCount} pieza
            {partCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
    </div>
  );
}

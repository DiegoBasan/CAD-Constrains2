import { useAssemblyStore, type ViewPreset, type TransformMode, type RotatePivotMode } from "../assembly/store";
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

const PIVOT_MODES: { id: RotatePivotMode; label: string; title: string }[] = [
  { id: "part", label: "Pieza", title: "Gira sobre el propio centro de la pieza" },
  { id: "camera", label: "Cámara", title: "Gira alrededor del punto que mira la cámara" },
  { id: "free", label: "Libre", title: "Giro libre tipo bola (arcball), sin eje fijo" },
];

function ToolbarButton({
  active,
  onClick,
  title,
  small,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title?: string;
  small?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded-md font-medium transition-colors ${small ? "px-2 py-1 text-[11px]" : "px-2.5 py-1.5 text-[12px]"}`}
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
  const rotatePivotMode = useAssemblyStore((s) => s.rotatePivotMode);
  const setRotatePivotMode = useAssemblyStore((s) => s.setRotatePivotMode);
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

      {transformMode === "rotate" && (
        <div className="flex items-center gap-1 pl-3" style={{ borderLeft: "1px solid var(--border)" }}>
          {PIVOT_MODES.map((m) => (
            <ToolbarButton
              key={m.id}
              small
              title={m.title}
              active={rotatePivotMode === m.id}
              onClick={() => setRotatePivotMode(m.id)}
            >
              {m.label}
            </ToolbarButton>
          ))}
        </div>
      )}

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

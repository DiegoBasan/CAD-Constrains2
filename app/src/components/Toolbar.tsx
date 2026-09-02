import { useAssemblyStore, type ViewPreset, type CameraProjection, type ColorMode, type TransformMode, type RotatePivotMode } from "../assembly/store";
import { ImportButton } from "./ImportButton";

const VIEWS: { id: ViewPreset; label: string }[] = [
  { id: "iso", label: "ISO" },
  { id: "front", label: "Frontal" },
  { id: "top", label: "Superior" },
  { id: "right", label: "Derecha" },
];

const PROJECTIONS: { id: CameraProjection; label: string; title: string }[] = [
  { id: "ortho", label: "Ortográfica", title: "Proyección ortográfica (sin perspectiva)" },
  { id: "perspective", label: "Perspectiva", title: "Proyección en perspectiva" },
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

const COLOR_MODES: { id: ColorMode; label: string; title: string }[] = [
  { id: "palette", label: "Colores", title: "Cada pieza con su propio color" },
  { id: "gray", label: "Gris", title: "Todas las piezas en gris uniforme rgb(173,173,177)" },
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
  const cameraProjection = useAssemblyStore((s) => s.cameraProjection);
  const setCameraProjection = useAssemblyStore((s) => s.setCameraProjection);
  const perspectiveFov = useAssemblyStore((s) => s.perspectiveFov);
  const setPerspectiveFov = useAssemblyStore((s) => s.setPerspectiveFov);
  const colorMode = useAssemblyStore((s) => s.colorMode);
  const setColorMode = useAssemblyStore((s) => s.setColorMode);
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
        {PROJECTIONS.map((p) => (
          <ToolbarButton
            key={p.id}
            small
            title={p.title}
            active={cameraProjection === p.id}
            onClick={() => setCameraProjection(p.id)}
          >
            {p.label}
          </ToolbarButton>
        ))}
      </div>

      {cameraProjection === "perspective" && (
        <div className="flex items-center gap-1.5 pl-3" style={{ borderLeft: "1px solid var(--border)" }}>
          <span className="text-[11px]" style={{ color: "var(--text-dim)" }}>
            Perspectiva
          </span>
          <input
            type="range"
            min={1}
            max={90}
            step={1}
            value={perspectiveFov}
            onChange={(e) => setPerspectiveFov(Number(e.target.value))}
            title="Cantidad de perspectiva (estilo Shapr3D) — de casi ortográfica a muy pronunciada"
            className="w-24"
          />
          <span className="w-7 text-right text-[11px] tabular-nums" style={{ color: "var(--text-dim)" }}>
            {Math.round(perspectiveFov)}°
          </span>
        </div>
      )}

      <div className="flex items-center gap-1 pl-3" style={{ borderLeft: "1px solid var(--border)" }}>
        {COLOR_MODES.map((c) => (
          <ToolbarButton
            key={c.id}
            small
            title={c.title}
            active={colorMode === c.id}
            onClick={() => setColorMode(c.id)}
          >
            {c.label}
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

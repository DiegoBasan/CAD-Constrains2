import { useAssemblyStore } from "../assembly/store";

const inputStyle: React.CSSProperties = {
  borderColor: "var(--border-strong)",
  background: "var(--bg-2)",
  color: "var(--text)",
};

export function KeyframesPanel() {
  const keyframes = useAssemblyStore((s) => s.keyframes);
  const isPlaying = useAssemblyStore((s) => s.isPlaying);
  const saveKeyframe = useAssemblyStore((s) => s.saveKeyframe);
  const deleteKeyframe = useAssemblyStore((s) => s.deleteKeyframe);
  const renameKeyframe = useAssemblyStore((s) => s.renameKeyframe);
  const playKeyframes = useAssemblyStore((s) => s.playKeyframes);
  const stopPlayback = useAssemblyStore((s) => s.stopPlayback);
  const partCount = useAssemblyStore((s) => s.partOrder.length);

  return (
    <div className="flex max-h-64 flex-col border-t" style={{ borderColor: "var(--border)" }}>
      <div
        className="flex items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}
      >
        Animación
        <button
          onClick={() => saveKeyframe()}
          disabled={partCount === 0 || isPlaying}
          className="rounded border px-1.5 py-0.5 text-[10px] font-medium normal-case disabled:opacity-40"
          style={{ borderColor: "var(--accent-dim)", color: "var(--accent)" }}
        >
          + Guardar pose
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {keyframes.length === 0 && (
          <div className="px-3 py-3 text-[11px]" style={{ color: "var(--text-dim)" }}>
            Mueve las piezas a una posición y guarda una pose; repite para crear una secuencia y reproducirla.
          </div>
        )}
        {keyframes.map((kf, i) => (
          <div key={kf.id} className="flex items-center gap-1.5 border-b px-3 py-1.5" style={{ borderColor: "var(--border)" }}>
            <span className="text-[10px] shrink-0" style={{ color: "var(--text-dim)" }}>
              {i + 1}
            </span>
            <input
              defaultValue={kf.name}
              onBlur={(e) => renameKeyframe(kf.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              disabled={isPlaying}
              className="min-w-0 flex-1 rounded border px-1.5 py-0.5 text-[11px]"
              style={inputStyle}
            />
            <button
              onClick={() => deleteKeyframe(kf.id)}
              disabled={isPlaying}
              title="Eliminar pose"
              className="shrink-0 text-[11px] disabled:opacity-40"
              style={{ color: "var(--danger)" }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between px-3 py-2" style={{ borderTop: "1px solid var(--border)" }}>
        {isPlaying ? (
          <button
            onClick={stopPlayback}
            className="w-full rounded-md border px-2 py-1.5 text-[11px] font-medium"
            style={{ borderColor: "var(--warn)", color: "var(--warn)" }}
          >
            ⏹ Detener
          </button>
        ) : (
          <button
            onClick={playKeyframes}
            disabled={keyframes.length < 2}
            className="w-full rounded-md border px-2 py-1.5 text-[11px] font-medium disabled:opacity-40"
            style={{ borderColor: "var(--accent-dim)", color: "var(--accent)", background: "var(--accent-bg)" }}
          >
            ▶ Reproducir secuencia
          </button>
        )}
      </div>
    </div>
  );
}

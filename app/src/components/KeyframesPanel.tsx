import { DEFAULT_SEGMENT_MS, useAssemblyStore } from "../assembly/store";
import { NumberField } from "./NumberField";

/** The travel-time control for the segment ending at `id` — sits between the previous
 * keyframe's chip and this one, so it reads left-to-right as "from here to here takes
 * X seconds," matching the field it actually edits (durationMs is the time to reach
 * THIS keyframe from the previous one, not from this one to the next). */
function SegmentDurationControl({ id, durationMs }: { id: string; durationMs: number | undefined }) {
  const isPlaying = useAssemblyStore((s) => s.isPlaying);
  const setKeyframeDurationSec = useAssemblyStore((s) => s.setKeyframeDurationSec);
  const pushHistorySnapshot = useAssemblyStore((s) => s.pushHistorySnapshot);
  const seconds = (durationMs ?? DEFAULT_SEGMENT_MS) / 1000;

  return (
    <div className="flex shrink-0 flex-col items-center gap-0.5 px-0.5" style={{ color: "var(--text-dim)" }}>
      <span className="text-[9px]">→</span>
      <label className="flex items-center gap-0.5 text-[10px]" title="Duración de este tramo (segundos)">
        <NumberField
          value={seconds}
          onCommit={(v) => setKeyframeDurationSec(id, v)}
          onCommitStart={pushHistorySnapshot}
          disabled={isPlaying}
          step={0.1}
          precision={1}
          className="w-9 rounded border px-0.5 py-0 text-center text-[10px]"
          style={{ borderColor: "var(--border-strong)", background: "var(--bg-2)", color: "var(--text)" }}
        />
        s
      </label>
    </div>
  );
}

function KeyframeChip({ id, index, name }: { id: string; index: number; name: string }) {
  const isPlaying = useAssemblyStore((s) => s.isPlaying);
  const previewKeyframe = useAssemblyStore((s) => s.previewKeyframe);
  const overwriteKeyframe = useAssemblyStore((s) => s.overwriteKeyframe);

  return (
    <div
      title={name}
      className="flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-1"
      style={{ borderColor: "var(--border-strong)", background: "var(--bg-2)" }}
    >
      <span className="w-3.5 text-center text-[11px] font-medium" style={{ color: "var(--text-dim)" }}>
        {index + 1}
      </span>
      <button
        onClick={() => previewKeyframe(id)}
        disabled={isPlaying}
        title="Ir a esta pose"
        className="shrink-0 rounded px-1 py-0.5 text-[12px] disabled:opacity-40"
        style={{ color: "var(--accent)" }}
      >
        ▶
      </button>
      <button
        onClick={() => overwriteKeyframe(id)}
        disabled={isPlaying}
        title="Reemplazar esta pose con la posición actual"
        className="shrink-0 rounded px-1 py-0.5 text-[11px] disabled:opacity-40"
        style={{ color: "var(--text-dim)" }}
      >
        ⤓
      </button>
    </div>
  );
}

export function KeyframesPanel() {
  const keyframes = useAssemblyStore((s) => s.keyframes);
  const isPlaying = useAssemblyStore((s) => s.isPlaying);
  const loopPlayback = useAssemblyStore((s) => s.loopPlayback);
  const setLoopPlayback = useAssemblyStore((s) => s.setLoopPlayback);
  const saveKeyframe = useAssemblyStore((s) => s.saveKeyframe);
  const playKeyframes = useAssemblyStore((s) => s.playKeyframes);
  const stopPlayback = useAssemblyStore((s) => s.stopPlayback);
  const partCount = useAssemblyStore((s) => s.partOrder.length);

  return (
    <div
      className="flex h-16 shrink-0 items-center gap-3 border-t px-3"
      style={{ borderColor: "var(--border)", background: "var(--bg-1)" }}
    >
      <div
        className="flex shrink-0 items-center gap-2 pr-3 text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: "var(--text-dim)", borderRight: "1px solid var(--border)" }}
      >
        Animación
      </div>

      <button
        onClick={() => saveKeyframe()}
        disabled={partCount === 0 || isPlaying}
        className="shrink-0 rounded-md border px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-40"
        style={{ borderColor: "var(--accent-dim)", color: "var(--accent)" }}
      >
        + Guardar pose
      </button>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1">
        {keyframes.length === 0 && (
          <span className="text-[11px]" style={{ color: "var(--text-dim)" }}>
            Mueve las piezas y guarda poses para crear una secuencia animada.
          </span>
        )}
        {keyframes.map((kf, i) => (
          <div key={kf.id} className="flex shrink-0 items-center">
            {i > 0 && <SegmentDurationControl id={kf.id} durationMs={kf.durationMs} />}
            <KeyframeChip id={kf.id} index={i} name={kf.name} />
          </div>
        ))}
      </div>

      <button
        onClick={() => setLoopPlayback(!loopPlayback)}
        title="Repetir la secuencia en bucle"
        className="shrink-0 rounded-md border px-2 py-1.5 text-[11px] font-medium"
        style={{
          borderColor: loopPlayback ? "var(--accent-dim)" : "var(--border-strong)",
          color: loopPlayback ? "var(--accent)" : "var(--text-dim)",
          background: loopPlayback ? "var(--accent-bg)" : "transparent",
        }}
      >
        ⟲ Bucle
      </button>

      {isPlaying ? (
        <button
          onClick={stopPlayback}
          className="shrink-0 rounded-md border px-3 py-1.5 text-[11px] font-medium"
          style={{ borderColor: "var(--warn)", color: "var(--warn)" }}
        >
          ⏹ Detener
        </button>
      ) : (
        <button
          onClick={playKeyframes}
          disabled={keyframes.length < 2}
          className="shrink-0 rounded-md border px-3 py-1.5 text-[11px] font-medium disabled:opacity-40"
          style={{ borderColor: "var(--accent-dim)", color: "var(--accent)", background: "var(--accent-bg)" }}
        >
          ▶ Reproducir secuencia
        </button>
      )}
    </div>
  );
}

import { DEFAULT_SEGMENT_MS, useAssemblyStore } from "../assembly/store";
import type { Pose, Vec3 } from "../occ/types";
import { NumberField } from "./NumberField";

/** The travel-time (and arc-via) control for the segment ending at `id` — sits between
 * the previous keyframe's chip and this one, so it reads left-to-right as "from here to
 * here takes X seconds," matching the field it actually edits (durationMs is the time
 * to reach THIS keyframe from the previous one, not from this one to the next). */
function SegmentDurationControl({
  id,
  durationMs,
  arcVia,
  prevPoses,
  poses,
}: {
  id: string;
  durationMs: number | undefined;
  arcVia: Map<string, Vec3> | undefined;
  prevPoses: Map<string, Pose>;
  poses: Map<string, Pose>;
}) {
  const isPlaying = useAssemblyStore((s) => s.isPlaying);
  const setKeyframeDurationSec = useAssemblyStore((s) => s.setKeyframeDurationSec);
  const pushHistorySnapshot = useAssemblyStore((s) => s.pushHistorySnapshot);
  const setArcVia = useAssemblyStore((s) => s.setArcVia);
  const clearArcVia = useAssemblyStore((s) => s.clearArcVia);
  const selectedPartId = useAssemblyStore((s) => s.selectedPartId);
  const selectedPartName = useAssemblyStore((s) => (selectedPartId ? s.parts.get(selectedPartId)?.part.name : undefined));
  const seconds = (durationMs ?? DEFAULT_SEGMENT_MS) / 1000;

  // An arc only makes sense for a part that actually travels through this segment —
  // one saved into both the previous keyframe and this one — so a part outside that
  // (added/removed between the two poses) can't be taught an arc here.
  const eligible = !!selectedPartId && poses.has(selectedPartId) && prevPoses.has(selectedPartId);
  const hasVia = !!selectedPartId && !!arcVia?.has(selectedPartId);
  const arcTitle = !selectedPartId
    ? "Selecciona una pieza para enseñarle un punto intermedio (arco) en este tramo"
    : !eligible
      ? `${selectedPartName ?? "Esta pieza"} no tiene pose guardada en ambos extremos de este tramo`
      : hasVia
        ? `Quitar el arco de ${selectedPartName} en este tramo (clic para volver a línea recta)`
        : `Enseñar el punto intermedio (arco) de ${selectedPartName} en este tramo — muévela a la posición deseada y haz clic`;

  return (
    <div className="flex shrink-0 flex-col items-center gap-0.5 px-0.5" style={{ color: "var(--text-dim)" }}>
      <div className="flex items-center gap-0.5">
        <span className="text-[9px]">→</span>
        <button
          onClick={() => (selectedPartId && (hasVia ? clearArcVia(id, selectedPartId) : setArcVia(id, selectedPartId)))}
          disabled={!eligible || isPlaying}
          title={arcTitle}
          className="shrink-0 rounded px-0.5 text-[10px] hover:opacity-80 disabled:opacity-30"
          style={{ color: hasVia ? "var(--accent)" : "var(--text-dim)" }}
        >
          🌀
        </button>
      </div>
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
            {i > 0 && (
              <SegmentDurationControl
                id={kf.id}
                durationMs={kf.durationMs}
                arcVia={kf.arcVia}
                prevPoses={keyframes[i - 1].poses}
                poses={kf.poses}
              />
            )}
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

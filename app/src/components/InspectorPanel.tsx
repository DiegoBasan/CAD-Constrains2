import { useState } from "react";
import * as THREE from "three";
import { useAssemblyStore, type AxisKey, type PartState } from "../assembly/store";
import { NumberField } from "./NumberField";

const inputStyle: React.CSSProperties = {
  borderColor: "var(--border-strong)",
  background: "var(--bg-2)",
  color: "var(--text)",
};

// The rotation row's fields are visually distinct from the position row above them, so
// "X°/Y°/Z°" reads unambiguously as rotation without needing the extra "R" — which
// matters here because that one extra character was enough, at this panel's width, to
// clip the field's own "-XX.XX" value behind its own right edge (verified: the input's
// scrollWidth exceeded its clientWidth by ~10px for exactly the Rx/Ry/Rz fields).
const AXES: { key: AxisKey; label: string }[] = [
  { key: "x", label: "X" },
  { key: "y", label: "Y" },
  { key: "z", label: "Z" },
  { key: "rx", label: "X°" },
  { key: "ry", label: "Y°" },
  { key: "rz", label: "Z°" },
];

function AxisField({
  label,
  value,
  locked,
  onCommit,
  onCommitStart,
  onCommitEnd,
  onToggleLock,
}: {
  label: string;
  value: number;
  locked: boolean;
  onCommit: (v: number) => void;
  onCommitStart: () => void;
  onCommitEnd: () => void;
  onToggleLock: () => void;
}) {
  return (
    <div className="flex flex-1 items-center gap-1 text-[11px]" style={{ color: "var(--text-dim)" }}>
      <button
        onClick={onToggleLock}
        title={locked ? `${label}: fijo — clic para liberar` : `${label}: libre — clic para fijar`}
        className="shrink-0 rounded px-0.5 text-[10px] hover:opacity-80"
        style={{ color: locked ? "var(--warn)" : "var(--text-dim)" }}
      >
        {locked ? "🔒" : "🔓"}
      </button>
      <label className="flex flex-1 items-center gap-0.5 min-w-0">
        {label}
        <NumberField
          value={value}
          onCommit={onCommit}
          onCommitStart={onCommitStart}
          onCommitEnd={onCommitEnd}
          disabled={locked}
          step={1}
          precision={2}
          className="w-full min-w-0 rounded border px-1 py-0.5 text-[11px]"
          style={inputStyle}
        />
      </label>
    </div>
  );
}

function AxisLimitRow({
  partId,
  axisKey,
  label,
  state,
  currentValue,
}: {
  partId: string;
  axisKey: AxisKey;
  label: string;
  state: PartState;
  currentValue: number;
}) {
  const setAxisLimits = useAssemblyStore((s) => s.setAxisLimits);
  const clearAxisLimits = useAssemblyStore((s) => s.clearAxisLimits);
  const range = state.axisLimits?.[axisKey];
  const hasLimit = range !== undefined;
  const isRotation = axisKey === "rx" || axisKey === "ry" || axisKey === "rz";

  return (
    <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--text-dim)" }}>
      <label className="flex w-16 shrink-0 items-center gap-1.5">
        <input
          type="checkbox"
          checked={hasLimit}
          onChange={(e) => {
            if (e.target.checked) {
              const span = isRotation ? 45 : 10;
              setAxisLimits(partId, axisKey, currentValue - span, currentValue + span);
            } else {
              clearAxisLimits(partId, axisKey);
            }
          }}
        />
        {label}
      </label>
      {hasLimit && (
        <>
          <input
            type="number"
            value={range[0]}
            onChange={(e) => setAxisLimits(partId, axisKey, Number(e.target.value), range[1])}
            className="w-16 rounded border px-1 py-0.5"
            style={inputStyle}
          />
          <span>–</span>
          <input
            type="number"
            value={range[1]}
            onChange={(e) => setAxisLimits(partId, axisKey, range[0], Number(e.target.value))}
            className="w-16 rounded border px-1 py-0.5"
            style={inputStyle}
          />
        </>
      )}
    </div>
  );
}

export function InspectorPanel() {
  const selectedPartId = useAssemblyStore((s) => s.selectedPartId);
  const parts = useAssemblyStore((s) => s.parts);
  const applyDragPreview = useAssemblyStore((s) => s.applyDragPreview);
  const runSolve = useAssemblyStore((s) => s.runSolve);
  const pushHistorySnapshot = useAssemblyStore((s) => s.pushHistorySnapshot);
  const setAxisLock = useAssemblyStore((s) => s.setAxisLock);
  const setCameraFov = useAssemblyStore((s) => s.setCameraFov);
  const [limitsOpen, setLimitsOpen] = useState(false);

  if (!selectedPartId) return null;
  const state = parts.get(selectedPartId);
  if (!state) return null;

  const [x, y, z] = state.pose.position;
  const quat = new THREE.Quaternion(...state.pose.quaternion);
  const euler = new THREE.Euler().setFromQuaternion(quat, "XYZ");
  const rx = THREE.MathUtils.radToDeg(euler.x);
  const ry = THREE.MathUtils.radToDeg(euler.y);
  const rz = THREE.MathUtils.radToDeg(euler.z);
  const values: Record<AxisKey, number> = { x, y, z, rx, ry, rz };

  // Live-preview each keystroke/scrub step the same way a viewport drag does — seed
  // the solver with the typed/scrubbed pose and let it settle within whatever freedom
  // the relations leave, in real time — then do one exact, fully-restarted solve when
  // the gesture ends (blur or scrub release) for a crisp final snap.
  function commitPosition(axis: 0 | 1 | 2, v: number) {
    const position = [...state!.pose.position] as [number, number, number];
    position[axis] = v;
    applyDragPreview(selectedPartId!, { position });
  }

  function commitRotationDeg(axis: "x" | "y" | "z", deg: number) {
    const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...state!.pose.quaternion), "XYZ");
    e[axis] = THREE.MathUtils.degToRad(deg);
    const q = new THREE.Quaternion().setFromEuler(e);
    applyDragPreview(selectedPartId!, { quaternion: [q.x, q.y, q.z, q.w] });
  }

  const committers: Record<AxisKey, (v: number) => void> = {
    x: (v) => commitPosition(0, v),
    y: (v) => commitPosition(1, v),
    z: (v) => commitPosition(2, v),
    rx: (v) => commitRotationDeg("x", v),
    ry: (v) => commitRotationDeg("y", v),
    rz: (v) => commitRotationDeg("z", v),
  };

  return (
    <div className="border-b px-3 py-3" style={{ borderColor: "var(--border)" }}>
      <div className="mb-2 truncate text-[11px] font-semibold" style={{ color: "var(--text-bright)" }}>
        {state.part.name}
      </div>
      {state.isCamera && (
        <label className="mb-2 flex items-center gap-2 text-[11px]" style={{ color: "var(--text-dim)" }}>
          Campo de visión (FOV)
          <NumberField
            value={Math.round(state.cameraFov ?? 50)}
            onCommit={(v) => setCameraFov(selectedPartId!, v)}
            onCommitStart={pushHistorySnapshot}
            step={1}
            precision={0}
            className="w-16 rounded border px-1.5 py-0.5"
            style={inputStyle}
          />
          °
        </label>
      )}
      <div className="mb-1.5 flex gap-2">
        {AXES.slice(0, 3).map(({ key, label }) => (
          <AxisField
            key={key}
            label={label}
            value={values[key]}
            locked={!!state.axisLock?.[key]}
            onCommit={committers[key]}
            onCommitStart={pushHistorySnapshot}
            onCommitEnd={runSolve}
            onToggleLock={() => setAxisLock(selectedPartId!, key, !state.axisLock?.[key])}
          />
        ))}
      </div>
      <div className="flex gap-2">
        {AXES.slice(3).map(({ key, label }) => (
          <AxisField
            key={key}
            label={label}
            value={values[key]}
            locked={!!state.axisLock?.[key]}
            onCommit={committers[key]}
            onCommitStart={pushHistorySnapshot}
            onCommitEnd={runSolve}
            onToggleLock={() => setAxisLock(selectedPartId!, key, !state.axisLock?.[key])}
          />
        ))}
      </div>

      <button
        onClick={() => setLimitsOpen((v) => !v)}
        className="mt-2 text-[11px] hover:opacity-80"
        style={{ color: "var(--text-dim)" }}
      >
        {limitsOpen ? "▾" : "▸"} Límites por eje
      </button>
      {limitsOpen && (
        <div className="mt-1.5 flex flex-col gap-1">
          {AXES.map(({ key, label }) => (
            <AxisLimitRow key={key} partId={selectedPartId} axisKey={key} label={label} state={state} currentValue={values[key]} />
          ))}
        </div>
      )}
    </div>
  );
}

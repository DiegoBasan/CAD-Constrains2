import * as THREE from "three";
import { useAssemblyStore } from "../assembly/store";
import { NumberField } from "./NumberField";

const inputStyle: React.CSSProperties = {
  borderColor: "var(--border-strong)",
  background: "var(--bg-2)",
  color: "var(--text)",
};

function AxisField({
  label,
  value,
  onCommit,
  onCommitStart,
  onCommitEnd,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  onCommitStart: () => void;
  onCommitEnd: () => void;
}) {
  return (
    <label className="flex flex-1 items-center gap-1 text-[11px]" style={{ color: "var(--text-dim)" }}>
      {label}
      <NumberField
        value={value}
        onCommit={onCommit}
        onCommitStart={onCommitStart}
        onCommitEnd={onCommitEnd}
        step={1}
        precision={2}
        className="w-full min-w-0 rounded border px-1.5 py-0.5 text-[11px]"
        style={inputStyle}
      />
    </label>
  );
}

export function InspectorPanel() {
  const selectedPartId = useAssemblyStore((s) => s.selectedPartId);
  const parts = useAssemblyStore((s) => s.parts);
  const applyDragPreview = useAssemblyStore((s) => s.applyDragPreview);
  const runSolve = useAssemblyStore((s) => s.runSolve);
  const pushHistorySnapshot = useAssemblyStore((s) => s.pushHistorySnapshot);

  if (!selectedPartId) return null;
  const state = parts.get(selectedPartId);
  if (!state) return null;

  const [x, y, z] = state.pose.position;
  const quat = new THREE.Quaternion(...state.pose.quaternion);
  const euler = new THREE.Euler().setFromQuaternion(quat, "XYZ");
  const rx = THREE.MathUtils.radToDeg(euler.x);
  const ry = THREE.MathUtils.radToDeg(euler.y);
  const rz = THREE.MathUtils.radToDeg(euler.z);

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

  return (
    <div className="border-b px-3 py-3" style={{ borderColor: "var(--border)" }}>
      <div className="mb-2 truncate text-[11px] font-semibold" style={{ color: "var(--text-bright)" }}>
        {state.part.name}
      </div>
      <div className="mb-1.5 flex gap-2">
        <AxisField label="X" value={x} onCommit={(v) => commitPosition(0, v)} onCommitStart={pushHistorySnapshot} onCommitEnd={runSolve} />
        <AxisField label="Y" value={y} onCommit={(v) => commitPosition(1, v)} onCommitStart={pushHistorySnapshot} onCommitEnd={runSolve} />
        <AxisField label="Z" value={z} onCommit={(v) => commitPosition(2, v)} onCommitStart={pushHistorySnapshot} onCommitEnd={runSolve} />
      </div>
      <div className="flex gap-2">
        <AxisField label="Rx°" value={rx} onCommit={(v) => commitRotationDeg("x", v)} onCommitStart={pushHistorySnapshot} onCommitEnd={runSolve} />
        <AxisField label="Ry°" value={ry} onCommit={(v) => commitRotationDeg("y", v)} onCommitStart={pushHistorySnapshot} onCommitEnd={runSolve} />
        <AxisField label="Rz°" value={rz} onCommit={(v) => commitRotationDeg("z", v)} onCommitStart={pushHistorySnapshot} onCommitEnd={runSolve} />
      </div>
    </div>
  );
}

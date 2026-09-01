import * as THREE from "three";
import { useAssemblyStore } from "../assembly/store";
import type { Vec3 } from "../occ/types";
import { NumberField } from "./NumberField";

const inputStyle: React.CSSProperties = {
  borderColor: "var(--border-strong)",
  background: "var(--bg-2)",
  color: "var(--text)",
};

function AxisField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  return (
    <label className="flex flex-1 items-center gap-1 text-[11px]" style={{ color: "var(--text-dim)" }}>
      {label}
      <NumberField
        value={value}
        onCommit={onCommit}
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
  const setPose = useAssemblyStore((s) => s.setPose);
  const runSolve = useAssemblyStore((s) => s.runSolve);

  if (!selectedPartId) return null;
  const state = parts.get(selectedPartId);
  if (!state) return null;

  const [x, y, z] = state.pose.position;
  const quat = new THREE.Quaternion(...state.pose.quaternion);
  const euler = new THREE.Euler().setFromQuaternion(quat, "XYZ");
  const rx = THREE.MathUtils.radToDeg(euler.x);
  const ry = THREE.MathUtils.radToDeg(euler.y);
  const rz = THREE.MathUtils.radToDeg(euler.z);

  function commitPosition(axis: 0 | 1 | 2, v: number) {
    const position = [...state!.pose.position] as Vec3;
    position[axis] = v;
    setPose(selectedPartId!, { position, quaternion: state!.pose.quaternion });
    runSolve();
  }

  function commitRotationDeg(axis: "x" | "y" | "z", deg: number) {
    const e = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(...state!.pose.quaternion), "XYZ");
    e[axis] = THREE.MathUtils.degToRad(deg);
    const q = new THREE.Quaternion().setFromEuler(e);
    setPose(selectedPartId!, { position: state!.pose.position, quaternion: [q.x, q.y, q.z, q.w] });
    runSolve();
  }

  return (
    <div className="border-b px-3 py-3" style={{ borderColor: "var(--border)" }}>
      <div className="mb-2 truncate text-[11px] font-semibold" style={{ color: "var(--text-bright)" }}>
        {state.part.name}
      </div>
      <div className="mb-1.5 flex gap-2">
        <AxisField label="X" value={x} onCommit={(v) => commitPosition(0, v)} />
        <AxisField label="Y" value={y} onCommit={(v) => commitPosition(1, v)} />
        <AxisField label="Z" value={z} onCommit={(v) => commitPosition(2, v)} />
      </div>
      <div className="flex gap-2">
        <AxisField label="Rx°" value={rx} onCommit={(v) => commitRotationDeg("x", v)} />
        <AxisField label="Ry°" value={ry} onCommit={(v) => commitRotationDeg("y", v)} />
        <AxisField label="Rz°" value={rz} onCommit={(v) => commitRotationDeg("z", v)} />
      </div>
    </div>
  );
}

import { useAssemblyStore } from "../assembly/store";

export function StatusBar() {
  const relations = useAssemblyStore((s) => s.relations.length);
  const partCount = useAssemblyStore((s) => s.partOrder.length);

  return (
    <div
      className="flex h-6 shrink-0 items-center gap-4 border-t px-3 text-[11px]"
      style={{ borderColor: "var(--border)", background: "var(--bg-1)", color: "var(--text-dim)" }}
    >
      <span>Piezas: {partCount}</span>
      <span>Relaciones: {relations}</span>
      <span className="ml-auto">Clic en una pieza para moverla · Shift+clic para seleccionar varias · Ctrl/Cmd+clic en dos caras/aristas para relacionarlas</span>
    </div>
  );
}

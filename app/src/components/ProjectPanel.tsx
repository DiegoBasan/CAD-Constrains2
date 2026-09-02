import { useRef, useState } from "react";
import { useAssemblyStore } from "../assembly/store";

/** Export/import the whole project (parts, meshes, relations, groups, cameras,
 * keyframes) as a downloadable .json file — distinct from "Importar STEP" (which adds
 * one file's geometry to whatever's already open): this replaces the entire assembly,
 * so you can save your work, close the tab, and pick a project back up later, or juggle
 * several projects without losing any of them. */
export function ProjectPanel() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const exportProject = useAssemblyStore((s) => s.exportProject);
  const importProject = useAssemblyStore((s) => s.importProject);
  const isEmpty = useAssemblyStore((s) => s.partOrder.length === 0);

  function handleExport() {
    const json = exportProject();
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "proyecto-cad.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImportFile(file: File) {
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        importProject(String(reader.result));
      } catch (e) {
        setError(e instanceof Error ? e.message : "No se pudo importar el proyecto.");
      }
    };
    reader.onerror = () => setError("No se pudo leer el archivo.");
    reader.readAsText(file);
  }

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleImportFile(file);
          e.target.value = "";
        }}
      />
      <button
        onClick={handleExport}
        disabled={isEmpty}
        title="Descarga todo el ensamble (piezas, relaciones, grupos, cámaras, poses) como un archivo .json"
        className="rounded-md border px-2.5 py-1.5 text-[12px] font-medium disabled:opacity-40"
        style={{ borderColor: "var(--border-strong)", background: "var(--bg-3)", color: "var(--text-bright)" }}
      >
        ⭳ Exportar proyecto
      </button>
      <button
        onClick={() => inputRef.current?.click()}
        title="Reemplaza el ensamble actual con uno guardado antes (archivo .json)"
        className="rounded-md border px-2.5 py-1.5 text-[12px] font-medium"
        style={{ borderColor: "var(--border-strong)", background: "var(--bg-3)", color: "var(--text-bright)" }}
      >
        ⭱ Importar proyecto
      </button>
      {error && <span className="text-[11px]" style={{ color: "var(--danger)" }}>{error}</span>}
    </div>
  );
}

import { useRef, useState } from "react";
import { importStepFile } from "../occ/stepImport";
import { useAssemblyStore } from "../assembly/store";

export function ImportButton() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const importAssembly = useAssemblyStore((s) => s.importAssembly);

  async function handleFile(file: File) {
    setStatus("loading");
    setError(null);
    try {
      const assembly = await importStepFile(file);
      importAssembly(assembly);
      setStatus("idle");
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "No se pudo importar el archivo STEP.");
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept=".step,.stp,.STEP,.STP"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
          e.target.value = "";
        }}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={status === "loading"}
        className="flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-60"
        style={{ borderColor: "var(--border-strong)", background: "var(--bg-3)", color: "var(--text-bright)" }}
      >
        {status === "loading" ? (
          <>
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Importando…
          </>
        ) : (
          <>Importar STEP</>
        )}
      </button>
      {error && <span className="text-[11px]" style={{ color: "var(--danger)" }}>{error}</span>}
    </div>
  );
}

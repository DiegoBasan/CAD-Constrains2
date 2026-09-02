import { useState } from "react";
import { useAssemblyStore } from "../assembly/store";
import { RELATION_LABELS, type Relation, type RelationType } from "../assembly/relations";
import type { EntityRef } from "../occ/types";

const NEEDS_VALUE: Partial<Record<RelationType, boolean>> = { distance: true, planar: true };

function entityLabel(ref: EntityRef, partName: string | undefined): string {
  if (ref.kind === "part") return partName ?? "?";
  return `${partName ?? "?"} · ${ref.kind === "face" ? "cara" : "arista"} #${ref.id}`;
}

function RelationSideRow({
  rel,
  side,
  parts,
}: {
  rel: Relation;
  side: "a" | "b";
  parts: ReturnType<typeof useAssemblyStore.getState>["parts"];
}) {
  const startEditRelationSide = useAssemblyStore((s) => s.startEditRelationSide);
  const editingRelationSide = useAssemblyStore((s) => s.editingRelationSide);
  const ref = rel[side];
  const isEditingThis = editingRelationSide?.relationId === rel.id && editingRelationSide.side === side;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="truncate" style={{ color: "var(--text-dim)" }}>
        {entityLabel(ref, parts.get(ref.partId)?.part.name)}
      </span>
      {rel.type !== "rigid" && (
        <button
          title={`Cambiar la cara/arista ${side.toUpperCase()}`}
          onClick={() => startEditRelationSide(rel.id, side)}
          className="shrink-0 rounded px-1 text-[11px] hover:opacity-80"
          style={{ color: isEditingThis ? "var(--warn)" : "var(--text-dim)" }}
        >
          {isEditingThis ? "…esperando clic" : "✎ cambiar"}
        </button>
      )}
    </div>
  );
}

function AngleLimitEditor({ rel }: { rel: Relation }) {
  const setRelationAngleLimits = useAssemblyStore((s) => s.setRelationAngleLimits);
  const clearRelationAngleLimits = useAssemblyStore((s) => s.clearRelationAngleLimits);
  const hasLimit = rel.angleMin !== undefined && rel.angleMax !== undefined;

  return (
    <div className="flex w-full flex-col gap-1.5">
      <label className="flex items-center gap-1.5" style={{ color: "var(--text-dim)" }}>
        <input
          type="checkbox"
          checked={hasLimit}
          onChange={(e) => {
            if (e.target.checked) setRelationAngleLimits(rel.id, -45, 45);
            else clearRelationAngleLimits(rel.id);
          }}
        />
        Limitar ángulo de giro
      </label>
      {hasLimit && (
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5" style={{ color: "var(--text-dim)" }}>
            Mín°
            <input
              type="number"
              value={rel.angleMin}
              onChange={(e) => setRelationAngleLimits(rel.id, Number(e.target.value), rel.angleMax!)}
              className="w-16 rounded border px-1 py-0.5"
              style={{ borderColor: "var(--border-strong)", background: "var(--bg-2)", color: "var(--text)" }}
            />
          </label>
          <label className="flex items-center gap-1.5" style={{ color: "var(--text-dim)" }}>
            Máx°
            <input
              type="number"
              value={rel.angleMax}
              onChange={(e) => setRelationAngleLimits(rel.id, rel.angleMin!, Number(e.target.value))}
              className="w-16 rounded border px-1 py-0.5"
              style={{ borderColor: "var(--border-strong)", background: "var(--bg-2)", color: "var(--text)" }}
            />
          </label>
        </div>
      )}
    </div>
  );
}

export function RelationsPanel() {
  const parts = useAssemblyStore((s) => s.parts);
  const pickedEntities = useAssemblyStore((s) => s.pickedEntities);
  const clearPicked = useAssemblyStore((s) => s.clearPicked);
  const addRelation = useAssemblyStore((s) => s.addRelation);
  const applicableRelationTypesForPicked = useAssemblyStore((s) => s.applicableRelationTypesForPicked);
  const relations = useAssemblyStore((s) => s.relations);
  const removeRelation = useAssemblyStore((s) => s.removeRelation);
  const toggleRelationFlip = useAssemblyStore((s) => s.toggleRelationFlip);
  const setRelationValue = useAssemblyStore((s) => s.setRelationValue);
  const editingRelationSide = useAssemblyStore((s) => s.editingRelationSide);
  const cancelEditRelationSide = useAssemblyStore((s) => s.cancelEditRelationSide);
  const isSolving = useAssemblyStore((s) => s.isSolving);
  const lastSolve = useAssemblyStore((s) => s.lastSolve);

  const [value, setValue] = useState(0);

  const applicable = applicableRelationTypesForPicked();

  return (
    <div className="flex h-full flex-col">
      <div
        className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: "var(--text-dim)", borderBottom: "1px solid var(--border)" }}
      >
        Relaciones
      </div>

      <div className="border-b px-3 py-3" style={{ borderColor: "var(--border)" }}>
        {editingRelationSide ? (
          <div className="mb-2 flex items-center justify-between gap-2 text-[11px]" style={{ color: "var(--warn)" }}>
            <span>Clic en una nueva cara/arista para reemplazar el lado {editingRelationSide.side.toUpperCase()}.</span>
            <button onClick={cancelEditRelationSide} className="underline" style={{ color: "var(--text-dim)" }}>
              Cancelar
            </button>
          </div>
        ) : (
          <div className="mb-2 text-[11px]" style={{ color: "var(--text-dim)" }}>
            Selección {pickedEntities.length}/2 — clic en dos caras o aristas de piezas distintas.
          </div>
        )}
        <div className="mb-2 flex flex-col gap-1">
          {pickedEntities.map((ref, i) => (
            <div
              key={i}
              className="truncate rounded px-2 py-1 text-[11px]"
              style={{ background: "var(--bg-2)", color: "var(--text)" }}
            >
              {entityLabel(ref, parts.get(ref.partId)?.part.name)}
            </div>
          ))}
        </div>
        {pickedEntities.length === 2 && (
          <>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {applicable.length === 0 && (
                <span className="text-[11px]" style={{ color: "var(--text-dim)" }}>
                  Sin relaciones aplicables para esta combinación.
                </span>
              )}
              {applicable.map((type) => (
                <button
                  key={type}
                  onClick={() => addRelation(type, value)}
                  className="rounded-md border px-2 py-1 text-[11px] font-medium"
                  style={{ borderColor: "var(--accent-dim)", color: "var(--accent)", background: "var(--accent-bg)" }}
                >
                  {RELATION_LABELS[type]}
                </button>
              ))}
            </div>
            {applicable.some((t) => NEEDS_VALUE[t]) && (
              <label className="mb-2 flex items-center gap-2 text-[11px]" style={{ color: "var(--text-dim)" }}>
                Distancia/offset (mm)
                <input
                  type="number"
                  value={value}
                  onChange={(e) => setValue(Number(e.target.value))}
                  className="w-20 rounded border px-1.5 py-0.5 text-[11px]"
                  style={{ borderColor: "var(--border-strong)", background: "var(--bg-2)", color: "var(--text)" }}
                />
              </label>
            )}
          </>
        )}
        {pickedEntities.length > 0 && (
          <button onClick={clearPicked} className="text-[11px] underline" style={{ color: "var(--text-dim)" }}>
            Limpiar selección
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {relations.length === 0 && (
          <div className="px-3 py-4 text-[12px]" style={{ color: "var(--text-dim)" }}>
            Aún no hay relaciones.
          </div>
        )}
        {relations.map((rel) => (
          <div key={rel.id} className="flex flex-col gap-1 border-b px-3 py-2 text-[11px]" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center justify-between">
              <span className="font-medium" style={{ color: "var(--text-bright)" }}>
                {RELATION_LABELS[rel.type]}
              </span>
              <button onClick={() => removeRelation(rel.id)} style={{ color: "var(--danger)" }}>
                Eliminar
              </button>
            </div>
            <RelationSideRow rel={rel} side="a" parts={parts} />
            <RelationSideRow rel={rel} side="b" parts={parts} />
            <div className="mt-1 flex flex-wrap items-center gap-3">
              {rel.type === "planar" && (
                <button
                  onClick={() => toggleRelationFlip(rel.id)}
                  className="rounded border px-1.5 py-0.5 text-[11px]"
                  style={{ borderColor: "var(--border-strong)", color: "var(--text-dim)" }}
                >
                  {rel.flip ? "↺ mismo sentido" : "↺ invertir sentido"}
                </button>
              )}
              {NEEDS_VALUE[rel.type] && (
                <label className="flex items-center gap-1.5" style={{ color: "var(--text-dim)" }}>
                  Offset (mm)
                  <input
                    type="number"
                    value={rel.value}
                    onChange={(e) => setRelationValue(rel.id, Number(e.target.value))}
                    className="w-16 rounded border px-1 py-0.5"
                    style={{ borderColor: "var(--border-strong)", background: "var(--bg-2)", color: "var(--text)" }}
                  />
                </label>
              )}
              {rel.type === "concentric" && <AngleLimitEditor rel={rel} />}
            </div>
          </div>
        ))}
      </div>

      <div
        className="flex items-center justify-between px-3 py-2 text-[11px]"
        style={{ borderTop: "1px solid var(--border)", color: "var(--text-dim)" }}
      >
        {isSolving && <span>Resolviendo…</span>}
        {!isSolving && lastSolve && relations.length > 0 && (
          <span style={{ color: lastSolve.converged ? "var(--ok)" : "var(--warn)" }}>
            {lastSolve.converged ? "Ensamble resuelto" : `Residual: ${lastSolve.residualNorm.toFixed(3)}`}
          </span>
        )}
      </div>
    </div>
  );
}

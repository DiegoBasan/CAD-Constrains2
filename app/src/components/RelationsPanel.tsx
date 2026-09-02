import { useMemo, useState } from "react";
import { useAssemblyStore, type PartState } from "../assembly/store";
import { RELATION_ICONS, RELATION_LABELS, relationResiduals, resolveEntity, type Relation, type RelationType } from "../assembly/relations";
import type { EntityRef } from "../occ/types";

const NEEDS_VALUE: Partial<Record<RelationType, boolean>> = { distance: true, planar: true };

// Above this, a relation's residual gets flagged as an active conflict rather than just
// "not perfectly zero" — the solver's own convergence tolerance (CONVERGENCE_TOL in
// solver.ts) is far tighter than this, but relations mix mm-scale distance residuals
// with ~radian-scale orientation ones, so this is deliberately a loose, visual-only
// "is something actually fighting this relation" cutoff, not a precision guarantee.
const RESIDUAL_CONFLICT_THRESHOLD = 0.5;

function entityLabel(ref: EntityRef, partName: string | undefined): string {
  if (ref.kind === "part") return partName ?? "?";
  return `${partName ?? "?"} · ${ref.kind === "face" ? "cara" : "arista"} #${ref.id}`;
}

/** How far each relation currently is from fully satisfied, recomputed straight from
 * live poses — independent of solver.ts's own aggregate `lastSolve.residualNorm`, which
 * only reports the total across every relation and axis lock combined, so a single
 * relation losing a tug-of-war against a locked axis or another relation is otherwise
 * invisible: the assembly can report "resuelto" overall while one relation is quietly
 * not getting its way. */
function useRelationResidualNorms(relations: Relation[], parts: Map<string, PartState>): Map<string, number> {
  return useMemo(() => {
    const out = new Map<string, number>();
    for (const rel of relations) {
      const partA = parts.get(rel.a.partId);
      const partB = parts.get(rel.b.partId);
      if (!partA || !partB) continue;
      const a = resolveEntity(partA.part, rel.a, partA.pose);
      const b = resolveEntity(partB.part, rel.b, partB.pose);
      if (!a || !b) continue;
      const r = relationResiduals(rel, a, b);
      out.set(rel.id, Math.sqrt(r.reduce((s, v) => s + v * v, 0)));
    }
    return out;
  }, [relations, parts]);
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
  const residualNorms = useRelationResidualNorms(relations, parts);

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
            <span>Ctrl/Cmd+clic en una nueva cara/arista para reemplazar el lado {editingRelationSide.side.toUpperCase()}.</span>
            <button onClick={cancelEditRelationSide} className="underline" style={{ color: "var(--text-dim)" }}>
              Cancelar
            </button>
          </div>
        ) : (
          <div className="mb-2 text-[11px]" style={{ color: "var(--text-dim)" }}>
            Selección {pickedEntities.length}/2 — Ctrl/Cmd+clic en dos caras o aristas de piezas distintas.
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
                  className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium"
                  style={{ borderColor: "var(--accent-dim)", color: "var(--accent)", background: "var(--accent-bg)" }}
                >
                  <span aria-hidden="true">{RELATION_ICONS[type]}</span>
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
        {relations.map((rel) => {
          const residual = residualNorms.get(rel.id);
          const inConflict = residual !== undefined && residual > RESIDUAL_CONFLICT_THRESHOLD;
          return (
          <div key={rel.id} className="flex flex-col gap-1 border-b px-3 py-2 text-[11px]" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 font-medium" style={{ color: "var(--text-bright)" }}>
                <span aria-hidden="true">{RELATION_ICONS[rel.type]}</span>
                {RELATION_LABELS[rel.type]}
                {residual !== undefined && (
                  <span
                    title={
                      inConflict
                        ? `En conflicto — no se puede satisfacer del todo (residual ${residual.toFixed(3)}), probablemente compitiendo con otra relación o un eje bloqueado`
                        : "Satisfecha"
                    }
                    className="ml-1 rounded px-1 text-[10px] font-normal"
                    style={{
                      color: inConflict ? "var(--warn)" : "var(--ok)",
                      background: inConflict ? "var(--accent-bg)" : "transparent",
                    }}
                  >
                    {inConflict ? `⚠ ${residual.toFixed(2)}` : "✓"}
                  </span>
                )}
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
          );
        })}
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

import { getOpenCascade, type OpenCascadeInstance } from "./init";
import { recenterPartMesh, tessellateShape } from "./tessellate";
import type { ImportedAssembly, ImportedPart } from "./types";

/** Splits a (possibly nested) compound into the list of rigid "leaf" shapes that make up
 * an assembly. We keep descending through compound-of-compounds (assembly/sub-assembly
 * nodes) and stop as soon as a compound's immediate children are themselves plain
 * (non-compound) shapes — that compound becomes one rigid part, even if it internally has
 * several solids/shells. A lone non-compound shape at any level is a leaf too. */
function collectLeafShapes(oc: OpenCascadeInstance, shape: OpenCascadeInstance, out: OpenCascadeInstance[]): void {
  const COMPOUND = oc.TopAbs_ShapeEnum.TopAbs_COMPOUND.value;
  if (shape.ShapeType().value !== COMPOUND) {
    out.push(shape);
    return;
  }

  const children: OpenCascadeInstance[] = [];
  for (
    const it = new oc.TopoDS_Iterator_2(shape, true, true);
    it.More();
    it.Next()
  ) {
    children.push(it.Value());
  }

  if (children.length === 0) {
    out.push(shape);
    return;
  }
  if (children.length === 1) {
    collectLeafShapes(oc, children[0], out);
    return;
  }

  const anyChildIsCompound = children.some((c) => c.ShapeType().value === COMPOUND);
  if (anyChildIsCompound) {
    for (const child of children) collectLeafShapes(oc, child, out);
  } else {
    out.push(shape);
  }
}

export async function importStepFile(file: File): Promise<ImportedAssembly> {
  const oc = await getOpenCascade();
  const bytes = new Uint8Array(await file.arrayBuffer());

  // NOTE: this opencascade.js WASM build's STEPControl_Reader.ReadFile silently
  // fails (RetError) for longer virtual-FS paths — keep this short.
  const path = "/u.step";
  oc.FS.writeFile(path, bytes);

  try {
    const reader = new oc.STEPControl_Reader_1();
    const readStatus = reader.ReadFile(path);
    if (readStatus.value !== oc.IFSelect_ReturnStatus.IFSelect_RetDone.value) {
      throw new Error("El archivo STEP no se pudo leer (formato inválido o corrupto).");
    }

    reader.TransferRoots();
    const nbShapes = reader.NbShapes();
    if (nbShapes === 0) {
      throw new Error("El archivo STEP no contiene geometría transferible.");
    }

    const roots: OpenCascadeInstance[] = [];
    for (let i = 1; i <= nbShapes; i++) roots.push(reader.Shape(i));

    const leaves: OpenCascadeInstance[] = [];
    for (const root of roots) collectLeafShapes(oc, root, leaves);

    // Tessellate each leaf shape as-is (full cumulative placement applied), so the
    // raw mesh always lands at its correct as-imported position — whether the file
    // encodes that via a proper assembly TopLoc_Location chain or bakes it directly
    // into the shape's own B-rep coordinates. Then re-center it around its own
    // bounding-box middle so the part has a sensible local origin to move/rotate
    // around (and for the gizmo to attach to) instead of always sitting at whatever
    // origin the file happened to use.
    const parts: ImportedPart[] = leaves.map((leafShape, index) => {
      const rawMesh = tessellateShape(oc, leafShape);
      const { mesh, origin } = recenterPartMesh(rawMesh);
      return {
        id: `part-${index + 1}`,
        name: `Pieza ${index + 1}`,
        mesh,
        initialPose: { position: origin, quaternion: [0, 0, 0, 1] },
      };
    });

    return { fileName: file.name, parts };
  } finally {
    try {
      oc.FS.unlink(path);
    } catch {
      // best-effort cleanup of the virtual FS entry
    }
  }
}

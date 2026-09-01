# CAD Assembler

A focused, modern web app for the four things a lightweight assembly viewer
actually needs — nothing more:

- **Isometric 3D viewport** (three.js, orthographic camera, iso/front/top/right presets)
- **Import STEP/STP files**, including multi-part assemblies
- **Move pieces** freely in the 3D scene (drag gizmo)
- **Positional relations** between independent pieces — coincident, concentric,
  planar (flush), distance, parallel — solved with a small numeric constraint solver

No feature/history tree, no sketching, no boolean operations, no format conversion.

## Architecture

Everything runs **client-side in the browser**, no backend:

- **[opencascade.js](https://github.com/donalffons/opencascade.js)** (OpenCascade compiled
  to WebAssembly) reads STEP files with real B-rep precision — exact face/edge geometry
  (plane normals, cylinder axes, circle centers), not just a triangle soup — which is what
  makes the positional relations possible.
- **three.js** renders the tessellated geometry and provides the isometric viewport,
  selection, and the move/rotate gizmo (`TransformControls`).
- **zustand** holds assembly state (parts, poses, relations, selection).
- A hand-rolled Levenberg–Marquardt solver (`src/assembly/solver.ts`) repositions the
  free (non-fixed) parts to satisfy the active relations whenever one is added or a
  drag ends.

See `app/src/occ/`, `app/src/assembly/`, and `app/src/scene/` for the three layers.

## Running it

```bash
cd app
npm install   # also copies the ~63MB opencascade.js WASM binary into public/
npm run dev
```

Then open the printed local URL and use **Importar STEP** to load a `.step`/`.stp` file.

## Notes

- The bundled `opencascade.js` build is LGPL-2.1, same license family as FreeCAD/OpenCascade.
- Part names default to "Pieza N" — this build reads STEP geometry directly rather than
  the (optional, more complex) XCAF product-structure layer, so original part/product
  names from the file aren't preserved yet.

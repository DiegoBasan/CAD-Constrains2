// Loads the OpenCascade.js WASM runtime once and caches the instance.
// The .wasm binary is served as a static asset from /public so Vite never
// tries to parse it as a module (avoids the Vite/Emscripten wasm-import mismatch).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import opencascadeFactory from "opencascade.js/dist/opencascade.wasm.js";

// The embind surface is thousands of C++ classes; we deliberately keep this
// typed as `any` at the binding boundary and expose strongly-typed wrappers
// from the rest of src/occ/* instead of hand-maintaining OCCT's full API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OpenCascadeInstance = any;

let instancePromise: Promise<OpenCascadeInstance> | null = null;

export function getOpenCascade(): Promise<OpenCascadeInstance> {
  let promise = instancePromise;
  if (!promise) {
    promise = opencascadeFactory({
      locateFile: (path: string) => {
        if (path.endsWith(".wasm")) return "/opencascade.wasm.wasm";
        return path;
      },
    });
    instancePromise = promise;
  }
  return promise;
}

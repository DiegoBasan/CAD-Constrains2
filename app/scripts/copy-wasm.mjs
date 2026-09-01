// Copies the OpenCascade.js WASM binary into public/ so Vite can serve it as a
// plain static asset. Runs automatically after `npm install` (see package.json).
// The file is intentionally NOT committed to the repo (63MB) — it always lives
// in node_modules already, so we just stage a copy where the browser can fetch it.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(rootDir, "node_modules/opencascade.js/dist/opencascade.wasm.wasm");
const destDir = join(rootDir, "public");
const dest = join(destDir, "opencascade.wasm.wasm");

if (!existsSync(src)) {
  console.warn("[copy-wasm] opencascade.js not installed yet, skipping.");
  process.exit(0);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log("[copy-wasm] copied opencascade.wasm.wasm into public/");

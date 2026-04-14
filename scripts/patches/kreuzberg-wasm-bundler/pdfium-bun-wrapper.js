// Bun + `bun build --compile` wrapper around the upstream pdfium.js
// Emscripten module.
//
// The upstream `pdfium.js` loads its sidecar wasm file
// (`pdfium.esm.wasm`) via `readBinary(locateFile('pdfium.esm.wasm'))` —
// a runtime `fs.readFileSync` with a path derived from
// `import.meta.url`. Under Bun's compiled virtual filesystem (`/$bunfs`),
// the wasm sidecar is only available if it is STATICALLY imported, and
// the read must go through `Bun.file` so the bundled asset is visible.
//
// Emscripten modules accept a `Module.wasmBinary` config option (a
// pre-loaded `Uint8Array`) which, when set, bypasses the entire
// `locateFile` + `readBinary` flow and uses the provided bytes directly
// for `WebAssembly.instantiate`. That is exactly what we need here.
//
// This wrapper:
//   1. Statically imports the sidecar wasm via `type: 'file'` so Bun's
//      compile pass sees it and bundles it into `/$bunfs`.
//   2. Reads the bytes through `Bun.file` at module load (works for both
//      real filesystem paths and `/$bunfs` paths).
//   3. Re-exports a default function that forwards to the upstream
//      `pdfium-original.js` with `wasmBinary` merged into the caller's
//      `Module` arg.
//
// The apply-kreuzberg-wasm-bundler.ts patch script installs this file as
// `dist/pdfium.js` and renames the upstream module to
// `dist/pdfium-original.js` so this wrapper can import it.

import OriginalPDFiumModule from "./pdfium-original.js";
import pdfiumWasmPath from "./pdfium.esm.wasm" with { type: "file" };

const __wasmBinary = await Bun.file(pdfiumWasmPath).bytes();

export default async function PDFiumModule(moduleArg = {}) {
  return OriginalPDFiumModule({ ...moduleArg, wasmBinary: __wasmBinary });
}

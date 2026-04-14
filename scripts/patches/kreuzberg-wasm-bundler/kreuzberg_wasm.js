/* @ts-self-types="./kreuzberg_wasm.d.ts" */
//
// Bun-compatible init for the wasm-bindgen bundler-target output.
//
// The upstream `wasm-pack build --target bundler` output does:
//
//     import * as wasm from "./kreuzberg_wasm_bg.wasm";
//     import { __wbg_set_wasm } from "./kreuzberg_wasm_bg.js";
//     __wbg_set_wasm(wasm);
//     wasm.__wbindgen_start();
//
// which relies on webpack/rollup/vite's semantics for `.wasm` imports:
// the bundler instantiates the module, links its imports to the sibling
// `kreuzberg_wasm_bg.js` namespace, and exposes the instance exports as
// the default module namespace. Bun does not do that — `import * as wasm
// from "./foo.wasm"` returns `{ default: <path-string> }`.
//
// This file adapts the bundler-target output for Bun + `bun build
// --compile`:
//
//   1. The `.wasm` static import resolves to a path. Under `bun run` it's
//      an absolute filesystem path; under `bun build --compile` it's a
//      path into `/$bunfs`. `Bun.file(path).bytes()` handles both.
//   2. We build an imports object from the bg.js namespace (every
//      `__wbg_*` export becomes an entry under the wasm module name that
//      wasm-bindgen expects — for a bundler-target build that is
//      `./kreuzberg_wasm_bg.js`).
//   3. `WebAssembly.instantiate(bytes, imports)` + `__wbg_set_wasm` +
//      `__wbindgen_start()` completes the standard wasm-bindgen init.
//
// Everything below the init block is re-exported from the bundler's
// `bg.js` helpers, exactly as the upstream glue does.
import wasmPath from "./kreuzberg_wasm_bg.wasm";
import * as wasmImports from "./kreuzberg_wasm_bg.js";
import { __wbg_set_wasm } from "./kreuzberg_wasm_bg.js";

const wasmBytes = await Bun.file(wasmPath).bytes();
const { instance } = await WebAssembly.instantiate(wasmBytes, {
    "./kreuzberg_wasm_bg.js": wasmImports,
});
__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();
export {
    ModuleInfo, PdfPageIteratorWasm, batchExtractBytes, batchExtractBytesSync, batchExtractFiles, batchExtractFilesSync, clear_ocr_backends, clear_post_processors, clear_validators, compress, decompress, detectMimeFromBytes, discoverConfig, extractBytes, extractBytesSync, extractFile, extractFileSync, getExtensionsForMime, getMimeFromExtension, get_module_info, init, initThreadPool, init_thread_pool_safe, initialize_pdfium_render, list_ocr_backends, list_post_processors, list_validators, loadConfigFromString, normalizeMimeType, ocrIsAvailable, read_block_from_callback_wasm, register_ocr_backend, register_post_processor, register_validator, renderPdfPageSync, unregister_ocr_backend, unregister_post_processor, unregister_validator, version, write_block_from_callback_wasm
} from "./kreuzberg_wasm_bg.js";

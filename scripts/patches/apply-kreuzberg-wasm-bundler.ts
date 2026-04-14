#!/usr/bin/env bun
// Patch @kreuzberg/wasm so it works inside `bun build --compile`.
//
// Why: upstream `@kreuzberg/wasm@4.8.5` publishes a wasm-bindgen glue module
// compiled with `wasm-pack --target web`. That glue contains a top-level
//   `const wasmUrl = new URL('kreuzberg_wasm_bg.wasm', import.meta.url);`
//   `await WebAssembly.instantiateStreaming(fetch(wasmUrl), ...)`
// which runs at import time. Inside a Bun-compiled binary's `/$bunfs`
// virtual FS, that `fetch(URL)` call cannot resolve the synthetic path, so
// the module throws before `initWasm` is ever called. The upstream loader
// also reaches the glue via `await import('./pkg/kreuzberg_wasm.js')` — a
// dynamic import with a runtime-computed specifier, which `bun build
// --compile` does not bundle.
//
// The fix is what wasm-bindgen calls "bundler target" output: glue that
// does `import * as wasm from './kreuzberg_wasm_bg.wasm'`. Bundlers
// (including Bun's compile mode) see the static wasm import, inline the
// bytes into the compiled binary, and initialization runs without any
// runtime file/URL lookup.
//
// This script:
//   1. Overwrites `node_modules/@kreuzberg/wasm/dist/pkg/*` with our locally
//      built bundler-target wasm-pack output (see
//      `scripts/patches/kreuzberg-wasm-bundler/`).
//   2. Prepends a static `import * as __kreuzbergGlue from './pkg/...'` to
//      `dist/index.js` and replaces the dynamic import loop with a direct
//      reference to that glue module.
//
// This is a Stage 1 shim — Stage 2 will either upstream the `bundler`
// target to `kreuzberg-dev/kreuzberg` or ship a proper fork package.
// See `docs/plans/2026-04-14-gdrivescope-tech-stack.md` §Technology stack.

import { existsSync } from 'node:fs';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = new URL('../../', import.meta.url);
const PATCH_DIR = new URL('./kreuzberg-wasm-bundler/', import.meta.url);
const TARGET_PKG = new URL(
  './node_modules/@kreuzberg/wasm/dist/pkg/',
  REPO_ROOT
);
const TARGET_DIST = new URL('./node_modules/@kreuzberg/wasm/dist/', REPO_ROOT);
const TARGET_INDEX = new URL('./index.js', TARGET_DIST);
const TARGET_PDFIUM = new URL('./pdfium.js', TARGET_DIST);
const TARGET_PDFIUM_ORIGINAL = new URL('./pdfium-original.js', TARGET_DIST);
const PDFIUM_WRAPPER_SRC = new URL('./pdfium-bun-wrapper.js', PATCH_DIR);

interface PkgFile {
  name: string;
  required: boolean;
}

const PKG_FILES: PkgFile[] = [
  { name: 'kreuzberg_wasm.js', required: true },
  { name: 'kreuzberg_wasm_bg.js', required: true },
  { name: 'kreuzberg_wasm_bg.wasm', required: true },
  { name: 'kreuzberg_wasm.d.ts', required: false },
  { name: 'kreuzberg_wasm_bg.wasm.d.ts', required: false },
];

async function log(message: string): Promise<void> {
  process.stderr.write(`[patch-kreuzberg-wasm] ${message}\n`);
}

async function copyPkgFiles(): Promise<void> {
  if (!existsSync(fileURLToPath(TARGET_PKG))) {
    throw new Error(
      `target pkg dir not found: ${fileURLToPath(TARGET_PKG)}. ` +
        'Did you run `bun install` first?'
    );
  }
  for (const file of PKG_FILES) {
    const src = new URL(file.name, PATCH_DIR);
    const dst = new URL(file.name, TARGET_PKG);
    if (!existsSync(fileURLToPath(src))) {
      if (file.required) {
        throw new Error(`missing patch file ${fileURLToPath(src)}`);
      }
      continue;
    }
    await copyFile(fileURLToPath(src), fileURLToPath(dst));
    await log(`copied ${file.name}`);
  }
}

const MARKER = '/* kreuzberg-wasm-bundler-patch:applied */';

const STATIC_IMPORT = `${MARKER}
import * as __kreuzbergGlue from './pkg/kreuzberg_wasm.js';
`;

async function patchIndex(): Promise<void> {
  const indexPath = fileURLToPath(TARGET_INDEX);
  if (!existsSync(indexPath)) {
    throw new Error(`target index not found: ${indexPath}`);
  }
  let source = await readFile(indexPath, 'utf8');
  if (source.includes(MARKER)) {
    await log('index.js already patched, skipping');
    return;
  }

  // 1. Prepend a static import of the bundler-target glue. Bun's compile
  //    mode will see this as a static dep on ./pkg/kreuzberg_wasm.js which
  //    in turn statically imports ./pkg/kreuzberg_wasm_bg.wasm, so the full
  //    glue + wasm bytes get bundled into the compiled binary.
  source = STATIC_IMPORT + source;

  // 2. Replace the dynamic `await import()` loop with a direct reference.
  //    The old code tries 4 runtime paths; we replace the whole block with
  //    a single assignment from our static import.
  const DYNAMIC_LOOP_RE =
    /const baseUrl = new URL\(import\.meta\.url\);\s*const modulePaths = \[[\s\S]*?\];\s*let wasmModule;\s*let lastError;\s*for \(const modulePath of modulePaths\) \{[\s\S]*?\}\s*if \(!wasmModule\) \{\s*throw lastError;\s*\}/;

  const REPLACEMENT = `const wasmModule = __kreuzbergGlue;`;

  if (!DYNAMIC_LOOP_RE.test(source)) {
    throw new Error(
      'could not locate dynamic-import loop in dist/index.js — ' +
        'upstream layout may have changed; patch needs review'
    );
  }
  source = source.replace(DYNAMIC_LOOP_RE, REPLACEMENT);

  await writeFile(indexPath, source, 'utf8');
  await log('patched dist/index.js');
}

async function installPdfiumWrapper(): Promise<void> {
  const pdfiumPath = fileURLToPath(TARGET_PDFIUM);
  const pdfiumOriginalPath = fileURLToPath(TARGET_PDFIUM_ORIGINAL);
  const wrapperSrcPath = fileURLToPath(PDFIUM_WRAPPER_SRC);

  if (!existsSync(pdfiumPath)) {
    throw new Error(`target pdfium.js not found: ${pdfiumPath}`);
  }
  if (!existsSync(wrapperSrcPath)) {
    throw new Error(`patch wrapper not found: ${wrapperSrcPath}`);
  }

  // Detect "already patched" by looking for our wrapper marker at the
  // top of dist/pdfium.js. If present, skip — the wrapper is in place
  // and dist/pdfium-original.js should already exist.
  const pdfiumContent = await readFile(pdfiumPath, 'utf8');
  const WRAPPER_MARKER =
    'Bun + `bun build --compile` wrapper around the upstream pdfium.js';
  if (pdfiumContent.includes(WRAPPER_MARKER)) {
    await log('pdfium.js already wrapped, skipping');
    return;
  }

  if (!existsSync(pdfiumOriginalPath)) {
    await rename(pdfiumPath, pdfiumOriginalPath);
    await log('renamed pdfium.js → pdfium-original.js');
  } else {
    await log('pdfium-original.js already present — overwriting pdfium.js');
  }

  await copyFile(wrapperSrcPath, pdfiumPath);
  await log('installed pdfium-bun-wrapper → dist/pdfium.js');
}

async function main(): Promise<void> {
  await log(`running from ${SELF}`);
  await copyPkgFiles();
  await patchIndex();
  await installPdfiumWrapper();
  await log('done');
}

await main();

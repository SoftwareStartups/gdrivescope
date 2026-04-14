#!/usr/bin/env bun
// Spike R1 — Kreuzberg markdown extraction under `bun run` and under
// `bun build --compile`.
//
// Status: **partial**. Under `bun run` both `@kreuzberg/node` (NAPI) and
// `@kreuzberg/wasm` work. Under `bun build --compile` **neither** works:
//
//   1. `@kreuzberg/node` — the NAPI binding uses `createRequire(...).resolve`
//      to locate its `.node` sidecar; that lookup can't traverse Bun's
//      compiled virtual filesystem (`/$bunfs`). Error:
//      `Cannot find module '../index.js' from '/$bunfs/root/<bin>'`.
//
//   2. `@kreuzberg/wasm` — `initWasm()` performs
//      `await import('./pkg/kreuzberg_wasm.js')` at runtime; Bun's compile
//      mode does not bundle runtime-computed import specifiers. Forcing a
//      static import of the glue file pushes the failure one step deeper:
//      the wasm-bindgen glue has a **top-level await** that does
//      `WebAssembly.instantiateStreaming(fetch(new URL('kreuzberg_wasm_bg.wasm', import.meta.url)))`,
//      which inside `/$bunfs` resolves to a URL that `fetch` cannot open
//      (observed as a garbled ENOENT). The `{ wasmModule }` option to
//      `initWasm` is applied *after* the glue's top-level init has already
//      run and crashed, so providing a pre-loaded WebAssembly.Module does
//      not rescue the flow.
//
// This spike therefore uses `@kreuzberg/wasm` via `bun run` only. The
// `bun build --compile` step in `scripts/spikes/README.md` is expected to
// fail until Stage 2 resolves R1 by one of:
//   - patching upstream Kreuzberg to support a fully-static wasm init path
//   - distributing the wasm assets as sidecar files next to the compiled
//     binary (defeats the single-binary goal)
//   - swapping to a narrow-format extractor stack: `pdf-parse` +
//     `mammoth` + `xlsx` (the fallback the tech-stack spec lists)
//
// See `docs/plans/2026-04-14-gdrivescope-tech-stack.md` §Technology stack
// for the amended risk note.

import { extractBytes, initWasm } from '@kreuzberg/wasm';
// Static file import so `bun build --compile` bundles the fixture into
// the binary. Under `bun run` this resolves to a real filesystem path;
// under `bun build --compile` it resolves to a path inside `/$bunfs`.
// `Bun.file(path).bytes()` handles both.
import fixturePath from './fixtures/sample.pdf' with { type: 'file' };

process.stderr.write('spike: initializing kreuzberg wasm…\n');
await initWasm();

process.stderr.write(`spike: loading fixture ${fixturePath}\n`);
const bytes = await Bun.file(fixturePath).bytes();

const result = await extractBytes(bytes, 'application/pdf', {
  outputFormat: 'markdown',
});

const preview = result.content.slice(0, 200);
process.stdout.write(`${preview}\n`);
process.stderr.write(
  `spike: OK — mime=${result.mimeType}, length=${result.content.length}\n`
);

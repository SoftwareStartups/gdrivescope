# Dependency risk spikes

Three throwaway scripts that de-risk technology choices flagged in `docs/plans/2026-04-14-gdrivescope-tech-stack.md` before Stage 2 touches real pipeline code. Stage 1's exit criteria require each spike to pass (or a fallback to be chosen + spec amended).

| Script | Validates | Risk id |
|---|---|---|
| `kreuzberg-compile.ts` | `@kreuzberg/node` NAPI works via `bun run` AND inside a `bun build --compile` binary | R1 |
| `sqlite-vec.ts` | `sqlite-vec` extension loads under `bun:sqlite` and a nearest-neighbor query works | R3 |
| `oauth-loopback.ts` | Google loopback 127.0.0.1 + PKCE flow end-to-end with a real account | OAuth |

## How to run

```bash
# From the gdrivescope project root

# 0. Regenerate the tiny fixture PDF (only needs to run once)
bun run scripts/spikes/fixtures/make-sample.ts

# R1 — kreuzberg under bun run AND inside a compiled binary
bun run scripts/spikes/kreuzberg-compile.ts
bun build --compile scripts/spikes/kreuzberg-compile.ts --outfile /tmp/kb-spike
/tmp/kb-spike

# R3 — sqlite-vec
bun run scripts/spikes/sqlite-vec.ts

# OAuth (requires real Google client creds)
GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... \
  bun run scripts/spikes/oauth-loopback.ts
```

## Success criteria

- **R1**: both invocations print a markdown preview containing the fixture's known phrase.
- **R3**: prints a JSON array of nearest-neighbor rowids + distances.
- **OAuth**: the browser opens, the user consents, the script prints refresh/access-token metadata to stderr and a `{"ok":true}` envelope to stdout.

## Results log

Dates in this log are local runs on darwin-arm64, Bun 1.3.11.

- **R1 `bun run` (via `@kreuzberg/node` NAPI)** — PASS, 2026-04-14. Extracted the fixture PDF to markdown; the known phrase round-trips.
- **R1 `bun run` (via `@kreuzberg/wasm`)** — PASS, 2026-04-14. Same behavior as the NAPI path.
- **R1 `bun build --compile` (via `@kreuzberg/node`)** — **FAIL**, 2026-04-14. NAPI binding's `createRequire(...).resolve` cannot locate the sidecar native module inside Bun's `/$bunfs` compiled filesystem. Error: `Cannot find module '../index.js' from '/$bunfs/root/kb-spike'`.
- **R1 `bun build --compile` (via `@kreuzberg/wasm`, default `initWasm()`)** — **FAIL**, 2026-04-14. The loader performs `await import('./pkg/kreuzberg_wasm.js')` at runtime; Bun's compile mode does not bundle runtime-computed specifiers. Error: `Cannot find module '../pkg/kreuzberg_wasm.js' from '/$bunfs/root/kb-spike'`.
- **R1 `bun build --compile` (via `@kreuzberg/wasm`, static import of JS glue + `{ wasmModule }` option)** — **FAIL**, 2026-04-14. Forcing a static import of `@kreuzberg/wasm/pkg/kreuzberg_wasm.js` makes Bun bundle the glue file, but the glue contains a top-level `await WebAssembly.instantiateStreaming(fetch(new URL('kreuzberg_wasm_bg.wasm', import.meta.url)))` that runs at import time and fails inside `/$bunfs` (`fetch` cannot open the synthetic URL). Providing a pre-loaded `wasmModule` to `initWasm` does not help because the glue's top-level init has already fired and crashed before `initWasm` gets a chance to use it.

**R1 verdict — initial**: risk materialized. Upstream `@kreuzberg/wasm@4.8.5` (and `@kreuzberg/node`) are unusable inside `bun build --compile` with Bun 1.3.11.

**R1 verdict — resolved via local fork + postinstall patch, 2026-04-14**: **PASS**. A minimal fork of `kreuzberg-dev/kreuzberg` rebuilt the wasm package with `wasm-pack build --target bundler` and a Bun-compatible init shim. The resulting pkg files plus a pdfium.js wrapper are committed under `scripts/patches/kreuzberg-wasm-bundler/` and applied to `node_modules/@kreuzberg/wasm` by `scripts/patches/apply-kreuzberg-wasm-bundler.ts`, which runs automatically as a `postinstall` hook. With the patch in place:

  - `bun run scripts/spikes/kreuzberg-compile.ts` → extracts the fixture PDF successfully (kreuzberg wasm + pdfium wasm both initialize).
  - `bun build --compile scripts/spikes/kreuzberg-compile.ts --outfile /tmp/kb-spike && /tmp/kb-spike` → extracts the fixture PDF successfully. Binary size ~81 MB (Bun runtime ~55 MB + kreuzberg wasm ~19 MB + pdfium wasm ~4 MB + glue).

The three changes the patch applies:

  1. **Bundler-target wasm-pack output replaces `dist/pkg/*`**. The upstream "target web" glue contains a top-level `await WebAssembly.instantiateStreaming(fetch(new URL('kreuzberg_wasm_bg.wasm', import.meta.url)))` that fires at module-import time and cannot open the synthetic `/$bunfs` URL. The bundler target emits `import * as wasm from "./kreuzberg_wasm_bg.wasm"` which bundlers resolve statically. We then replace that bundler-target init with a Bun-compatible variant that uses `import path from './...wasm' with { type: 'file' }` + `Bun.file(path).bytes()` + `WebAssembly.instantiate`, because Bun's `.wasm` static import returns a path string (not an instantiated namespace like webpack/rollup/vite do).

  2. **`dist/index.js` is patched to replace the runtime dynamic-import loop with a prepended static `import * as __kreuzbergGlue from './pkg/kreuzberg_wasm.js'`**. The upstream loader tries `await import(...)` against four runtime-computed paths; Bun compile doesn't bundle any of them. The static import makes the dependency visible to Bun's module graph.

  3. **`dist/pdfium.js` is replaced with a thin wrapper around `pdfium-original.js` (the renamed upstream Emscripten module) that pre-loads the sidecar `pdfium.esm.wasm` via `type: 'file'` import + `Bun.file(...).bytes()` and passes the bytes through as `Module.wasmBinary`**. Emscripten honors `wasmBinary` and skips its internal `locateFile` + `readBinary` flow, which was trying to `fs.readFileSync('/$bunfs/root/pdfium.esm.wasm')` and failing.

**Fork-and-patch architecture**:
  - The upstream rebuild happened in a scratch clone with `wasm-pack build --target bundler --out-dir pkg-bundler --release`. Rust 1.91 + wasm32-unknown-unknown target + `wasm-pack 0.14.0` were installed locally; Homebrew LLVM was needed for C deps (tree-sitter) that Apple's bundled clang can't compile to wasm32. Build took ~3 minutes.
  - The committed artifacts are the rebuilt `kreuzberg_wasm.js` / `kreuzberg_wasm_bg.js` / `kreuzberg_wasm_bg.wasm` / `.d.ts` files from `pkg-bundler/`, plus our Bun-compatible init overrides for `kreuzberg_wasm.js` and `pdfium.js`. These live in `scripts/patches/kreuzberg-wasm-bundler/` and total ~19 MB (dominated by the wasm binary — same size that would end up in the compiled binary regardless).
  - The patch script is idempotent (detects previous runs via markers) so rerunning `bun install` is safe.
  - **4.8.5 → 4.8.6 rebuild, 2026-04-18**: rebuilt bundler-target artifacts against `v4.8.6` of `kreuzberg-dev/kreuzberg` with `rustc 1.94.1` + `wasm-pack 0.14.0`. Upstream `dist/index.js` layout unchanged — `DYNAMIC_LOOP_RE` matched without edit. The `kreuzberg_wasm_bg.js` diff was limited to wasm-bindgen closure hash renames; public API export list in `kreuzberg_wasm.js` is identical to 4.8.5 (40 symbols). Wasm binary size nudged from 19,463,849 → 19,484,682 bytes. R1 spike re-verified: PASS under both `bun run` and `bun build --compile`. Bump workflow is now automated via `scripts/patches/rebuild-kreuzberg-wasm-bundler.ts` (see the `kreuzberg-wasm-bump` skill).

**What Stage 2 should do**: upstream a PR to `kreuzberg-dev/kreuzberg` adding the bundler-target output + Bun init variant behind a subpath export (`@kreuzberg/wasm/bundler`). Maintainers are likely to accept it — it matches what the rest of the wasm-bindgen ecosystem does for Vite/Webpack/Rollup. Until the PR lands, the committed patch keeps the build green on every machine + CI runner that runs `bun install`. Rebuild the patch artifacts when bumping the `@kreuzberg/wasm` version, since the bg.js helper exports change with the wasm signatures.

- **R3 `bun:sqlite + sqlite-vec`** — **PASS (with caveat)**, 2026-04-14 on darwin-arm64. Bun's bundled SQLite is compiled *without* dynamic extension loading, so a vanilla `new Database(':memory:')` rejects `db.loadExtension()` with `This build of sqlite3 does not support dynamic extension loading`. The fix is to call `Database.setCustomSQLite(path)` before opening the first database, pointing at a system SQLite that enables `SQLITE_ENABLE_LOAD_EXTENSION`:
    - macOS: Homebrew keg-only `sqlite` → `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib` (`brew install sqlite`).
    - Linux: `libsqlite3.so.0` on Debian/Ubuntu — the distro package is built from the canonical amalgamation and ships with extension loading enabled.
    - Windows: official SQLite DLL from https://sqlite.org/download.html → `sqlite-dll-win-x64-<ver>.zip` (or `-arm64-`). The canonical amalgamation does **not** define `SQLITE_OMIT_LOAD_EXTENSION`, so these DLLs have `sqlite3_load_extension` compiled in. User drops `sqlite3.dll` on PATH or points `GDRIVESCOPE_SQLITE_LIB` at the exact path.
  With that in place, the spike successfully reports `vec_version=v0.1.9`, creates a `vec0` virtual table, inserts three vectors, and returns three nearest-neighbor rows ordered by distance.

  **Portability caveat — accepted**: gdrivescope will document the system-libsqlite3 requirement in README.md and fail fast at `index` / `search` time with a clear message pointing users at the official SQLite download page (Windows) or their package manager (macOS/Linux). `GDRIVESCOPE_SQLITE_LIB` env var stays as the escape hatch for non-standard install locations. The "zero system deps" promise is downgraded to "one system dep: a SQLite DLL with `sqlite3_load_extension`, readily available on every target platform".

- **OAuth loopback** — **PASS**, 2026-04-14 on darwin-arm64. Full end-to-end flow exercised with a real Desktop-app OAuth client:
  - listener bound on `http://127.0.0.1:54340/oauth2callback`
  - browser opened the authorize URL with PKCE S256
  - consent granted, callback received with valid `state`
  - token exchange against `https://oauth2.googleapis.com/token` succeeded
  - access token returned (`ya29.a0Aa7MY…`), `refresh_token=present`, `expires_in=3599s`, `scope=https://www.googleapis.com/auth/drive.metadata.readonly`
  - stdout emitted `{"ok":true,"data":{"hasRefresh":true,"expires_in":3599,"scope":"…drive.metadata.readonly"}}`

  **Verdict**: Stage 2 can lift the spike into `src/auth/oauth.ts` verbatim. The script uses no SDK — just `Bun.serve`, `crypto.subtle` for PKCE, and `fetch` to the token endpoint — so it has no external coupling to migrate. The only thing to add in Stage 2 is persisting the `refresh_token` via `Bun.secrets` (see `src/auth/keychain.ts`).

  **Reproducing the spike**: requires `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` from a Desktop-app OAuth 2.0 Client. No redirect URIs need to be pre-registered — loopback 127.0.0.1 with any port is accepted automatically for installed-app clients.
  ```bash
  GOOGLE_OAUTH_CLIENT_ID=<your-client-id> \
    GOOGLE_OAUTH_CLIENT_SECRET=<your-client-secret> \
    bun run scripts/spikes/oauth-loopback.ts
  ```

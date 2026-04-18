---
name: kreuzberg-wasm-bump
description: Bump the vendored `@kreuzberg/wasm` release in gdrivescope. Activate when user asks to update, upgrade, bump, rebuild, or patch kreuzberg-wasm, `@kreuzberg/wasm`, or the vendored wasm-pack bundler artifacts under `scripts/patches/kreuzberg-wasm-bundler/`. Examples: "bump kreuzberg wasm to 4.8.7", "update @kreuzberg/wasm", "rebuild the kreuzberg wasm patch", "there's a new kreuzberg release".
---

# kreuzberg-wasm bump

Mechanical procedure for bumping `@kreuzberg/wasm` in gdrivescope. The package can't be bumped with a plain `bun update` because it ships a `--target web` wasm-pack glue that crashes inside `bun build --compile`. gdrivescope vendors a locally rebuilt `--target bundler` output under `scripts/patches/kreuzberg-wasm-bundler/` and re-applies it at every `bun install` via the `postinstall` hook in `package.json`. Bumping means rebuilding those vendored artifacts against the new upstream tag.

## When to use

Activate on: "bump kreuzberg-wasm", "update kreuzberg wasm to X.Y.Z", "there's a new @kreuzberg/wasm release", "rebuild vendored kreuzberg artifacts". Do **not** activate on general dependency bumps (`bun update`) — this skill only covers `@kreuzberg/wasm`.

## Prereqs (one-time)

- Rust 1.91+ with `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)
- `wasm-pack 0.14.0` (`curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh`)
- Homebrew LLVM (`brew install llvm`) — Apple's bundled clang can't compile tree-sitter to wasm32
- `source ~/.cargo/env` in every shell where you run the rebuild script

Verify before starting: `rustc --version && wasm-pack --version && ls /opt/homebrew/opt/llvm/bin/clang`.

## Procedure

1. **Find the target version.** `npm view @kreuzberg/wasm version` — usually the caller gives this; otherwise pick `latest`.

2. **Rebuild the vendored artifacts.** This script clones the upstream repo at the tag, runs `wasm-pack --target bundler`, copies the fresh `kreuzberg_wasm_bg.{wasm,js}` + `*.d.ts` into the patch dir, and diffs the public-API export list against the Bun init shim.

   ```bash
   source ~/.cargo/env
   bun run scripts/patches/rebuild-kreuzberg-wasm-bundler.ts <version>
   ```

   Expected runtime: ~3 min (Rust compile). The script exits non-zero with a diff if the public-API export list drifted.

3. **Handle export-list drift (only if step 2 exited non-zero).** Open `scripts/patches/kreuzberg-wasm-bundler/kreuzberg_wasm.js` and edit the `export { … } from "./kreuzberg_wasm_bg.js";` block at the bottom. Add the `+ added` symbols and remove the `- removed` ones from the script's output. Do **not** touch the header comment or the init block above it — that's our own Bun shim (`Bun.file(wasmPath).bytes()` + `WebAssembly.instantiate` + `__wbg_set_wasm` + `__wbindgen_start()`). Re-run step 2 to confirm the diff is clean.

4. **Sanity-check runtime imports.** `src/extract/kreuzberg.ts` imports `initWasm` and `extractBytes` from the **package root**, not from the pkg shim. `initWasm` is defined in upstream's `dist/index.js`; if upstream ever renames it, `task check` will surface it.

5. **Bump `package.json`.** Change `"@kreuzberg/wasm"` to `"^<version>"`. If this bump spans a minor (e.g., `4.8.x → 4.9.x`), also review `CHANGELOG.md` upstream for breaking changes in the `initWasm`/`extractBytes` signatures.

6. **Install and apply the patch.**

   ```bash
   bun install
   ```

   Expect the postinstall stderr to include 8 `[patch-kreuzberg-wasm]` lines ending in `done`. If it instead prints `could not locate dynamic-import loop in dist/index.js`, upstream rewrote `dist/index.js`; open `scripts/patches/apply-kreuzberg-wasm-bundler.ts` and update `DYNAMIC_LOOP_RE`.

7. **Verify.**

   ```bash
   task check                                  # lint + typecheck + unit/integration tests
   task compile                                # produces dist/gdrivescope (macOS ad-hoc signed)
   ./dist/gdrivescope --version                # must print version cleanly (no SIGKILL/137)
   bun run scripts/spikes/kreuzberg-compile.ts # extracts the fixture PDF under `bun run`
   bun build --compile scripts/spikes/kreuzberg-compile.ts --outfile /tmp/kb-spike
   codesign --remove-signature /tmp/kb-spike 2>/dev/null || true
   codesign --force --sign - /tmp/kb-spike
   /tmp/kb-spike                               # extracts the fixture from /$bunfs
   ```

   All four gates must pass. The spike output must contain "Hello from gdrivescope spike fixture. Kreuzberg, read me." in both invocations.

8. **Update the cosmetic version reference** in `scripts/patches/apply-kreuzberg-wasm-bundler.ts` header comment (the `@kreuzberg/wasm@X.Y.Z` reference in the "Why" block).

9. **Log the rebuild.** Append a dated entry under the R1 resolved-via-fork section in `scripts/spikes/README.md` with: rebuild date, tested rustc version, whether `DYNAMIC_LOOP_RE` still matched, the public-API symbol count, wasm binary size delta.

10. **Commit.** Use the project's conventional-commit format (first line ≤ 50 chars):

    ```
    chore(deps): bump @kreuzberg/wasm to <version>
    ```

    Body: one paragraph summarizing the rebuild, the symbol-count + dist/index.js regex status, and any shim edits made in step 3.

## Known failure modes

- **`DYNAMIC_LOOP_RE` no longer matches `dist/index.js`.** Upstream moved the dynamic-import block. Open `node_modules/@kreuzberg/wasm/dist/index.js`, find the `modulePaths`/`for (const modulePath of modulePaths)` loop, and update the regex in `scripts/patches/apply-kreuzberg-wasm-bundler.ts` line 114. The replacement is always `const wasmModule = __kreuzbergGlue;`.
- **Public API rename.** If upstream renames `extractBytes` or `initWasm`, `task check` catches the import failure. Fix `src/extract/kreuzberg.ts` with an `import { extractBytes, newName as initWasm }` aliasing and update the call site if the signature changed.
- **pdfium Emscripten module refactor.** If upstream swaps pdfium out for a different PDF renderer, the `pdfium-bun-wrapper.js` + rename-to-`pdfium-original.js` dance in `apply-kreuzberg-wasm-bundler.ts` will fail. In that case, stop and escalate — the whole wrapper approach needs revisiting.
- **`bun install` succeeds but `task compile` produces a 137-killed binary.** Missing ad-hoc codesign after the Bun `--compile` step. `task compile` already does this on macOS; see CLAUDE.md §"macOS binary signing".

## Files this skill touches

- `package.json` — bump `@kreuzberg/wasm` range
- `bun.lock` — regenerated by `bun install`
- `scripts/patches/kreuzberg-wasm-bundler/kreuzberg_wasm_bg.wasm` — replaced by rebuild script
- `scripts/patches/kreuzberg-wasm-bundler/kreuzberg_wasm_bg.js` — replaced by rebuild script
- `scripts/patches/kreuzberg-wasm-bundler/kreuzberg_wasm.d.ts` — replaced by rebuild script
- `scripts/patches/kreuzberg-wasm-bundler/kreuzberg_wasm_bg.wasm.d.ts` — replaced by rebuild script
- `scripts/patches/kreuzberg-wasm-bundler/kreuzberg_wasm.js` — **manual edit only if the rebuild script reports export-list drift**
- `scripts/patches/kreuzberg-wasm-bundler/pdfium-bun-wrapper.js` — **never edit here during a bump**; Emscripten `Module.wasmBinary` contract is version-independent
- `scripts/patches/apply-kreuzberg-wasm-bundler.ts` — header comment version ref; only edit the regex if step 6 reports a mismatch
- `scripts/spikes/README.md` — append a dated rebuild log entry

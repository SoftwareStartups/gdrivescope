#!/usr/bin/env bun
// Rebuild the vendored bundler-target wasm-pack output against a given
// upstream `@kreuzberg/wasm` release.
//
// Usage:   bun run scripts/patches/rebuild-kreuzberg-wasm-bundler.ts <version>
// Example: bun run scripts/patches/rebuild-kreuzberg-wasm-bundler.ts 4.8.6
//
// What this automates (see scripts/spikes/README.md §R1 for background):
//   1. Scratch-clones kreuzberg-dev/kreuzberg at tag `v<version>` into
//      `/tmp/kreuzberg-v<version>`.
//   2. Runs `wasm-pack build --target bundler --release` with the Homebrew
//      LLVM toolchain wired up for wasm32 (tree-sitter needs it).
//   3. Copies the fresh `kreuzberg_wasm_bg.{wasm,js}` + `*.d.ts` into
//      `scripts/patches/kreuzberg-wasm-bundler/`.
//   4. Diffs the new public-API export list against the one in the
//      committed Bun init shim (`kreuzberg_wasm.js`). If it drifted,
//      reports the delta and exits non-zero — the caller must then patch
//      the shim's `export { ... } from "./kreuzberg_wasm_bg.js";` line.
//   5. Leaves `kreuzberg_wasm.js` and `pdfium-bun-wrapper.js` untouched —
//      both are our own files, not upstream's.
//
// Prereqs (one-time on macOS; see scripts/spikes/README.md):
//   - Rust 1.91+ with wasm32-unknown-unknown target
//   - wasm-pack 0.14.0
//   - Homebrew LLVM (`brew install llvm`)
//
// After a successful rebuild, bump `package.json`'s `@kreuzberg/wasm`
// range, run `bun install`, and verify with:
//   task check && task compile && ./dist/gdrivescope --version
//   bun run scripts/spikes/kreuzberg-compile.ts

import { existsSync } from 'node:fs';
import { copyFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { $ } from 'bun';

const PATCH_DIR = new URL('./kreuzberg-wasm-bundler/', import.meta.url);
const SHIM_PATH = new URL('./kreuzberg_wasm.js', PATCH_DIR);

const COPY_FILES = [
  'kreuzberg_wasm_bg.wasm',
  'kreuzberg_wasm_bg.js',
  'kreuzberg_wasm.d.ts',
  'kreuzberg_wasm_bg.wasm.d.ts',
] as const;

function log(msg: string): void {
  process.stderr.write(`[rebuild-kreuzberg-wasm] ${msg}\n`);
}

function die(msg: string): never {
  process.stderr.write(`[rebuild-kreuzberg-wasm] error: ${msg}\n`);
  process.exit(1);
}

function parseVersion(argv: string[]): string {
  const v = argv[2];
  if (!v) {
    die(
      'missing version argument — usage: bun run scripts/patches/rebuild-kreuzberg-wasm-bundler.ts <version>'
    );
  }
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v)) {
    die(`version "${v}" does not look like a semver (e.g. 4.8.6)`);
  }
  return v;
}

async function ensureToolchain(): Promise<void> {
  const checks = [
    { cmd: 'rustc', label: 'rustc (Rust 1.91+)' },
    { cmd: 'wasm-pack', label: 'wasm-pack (0.14.0)' },
    {
      cmd: '/opt/homebrew/opt/llvm/bin/clang',
      label: 'Homebrew LLVM clang',
      isPath: true,
    },
  ];
  for (const check of checks) {
    if (check.isPath) {
      if (!existsSync(check.cmd)) {
        die(
          `missing ${check.label} at ${check.cmd} — run \`brew install llvm\``
        );
      }
      continue;
    }
    const out = await $`command -v ${check.cmd}`.nothrow().quiet();
    if (out.exitCode !== 0) {
      die(
        `missing ${check.label} on PATH — source ~/.cargo/env or install via rustup`
      );
    }
  }
}

async function cloneRepo(version: string): Promise<string> {
  const dir = `/tmp/kreuzberg-v${version}`;
  if (existsSync(dir)) {
    log(`removing stale clone at ${dir}`);
    await rm(dir, { recursive: true, force: true });
  }
  log(`cloning kreuzberg-dev/kreuzberg at v${version} → ${dir}`);
  await $`git clone --branch v${version} --depth 1 https://github.com/kreuzberg-dev/kreuzberg.git ${dir}`.quiet();
  const wasmCrate = `${dir}/crates/kreuzberg-wasm`;
  if (!existsSync(wasmCrate)) {
    die(
      `expected wasm crate at ${wasmCrate} but it is missing — upstream may have moved it`
    );
  }
  return wasmCrate;
}

async function wasmPackBuild(wasmCrate: string): Promise<string> {
  log('running wasm-pack build --target bundler --release (~3 min)…');
  const env = {
    ...process.env,
    PATH: `/opt/homebrew/opt/llvm/bin:${process.env.PATH}`,
    CC_wasm32_unknown_unknown: '/opt/homebrew/opt/llvm/bin/clang',
    AR_wasm32_unknown_unknown: '/opt/homebrew/opt/llvm/bin/llvm-ar',
  };
  const result =
    await $`wasm-pack build --target bundler --out-dir pkg-bundler --release`
      .cwd(wasmCrate)
      .env(env)
      .nothrow();
  if (result.exitCode !== 0) {
    process.stderr.write(result.stderr.toString());
    die(`wasm-pack build failed with exit code ${result.exitCode}`);
  }
  const pkg = `${wasmCrate}/pkg-bundler`;
  for (const f of COPY_FILES) {
    if (!existsSync(`${pkg}/${f}`)) {
      die(`wasm-pack did not produce ${pkg}/${f}`);
    }
  }
  return pkg;
}

async function copyArtifacts(pkg: string): Promise<void> {
  const patchDir = fileURLToPath(PATCH_DIR);
  for (const f of COPY_FILES) {
    await copyFile(`${pkg}/${f}`, `${patchDir}${f}`);
    log(`copied ${f}`);
  }
}

function extractShimExports(shimSource: string): Set<string> {
  const match = shimSource.match(
    /export \{([\s\S]*?)\} from "\.\/kreuzberg_wasm_bg\.js";/
  );
  if (!match) {
    die(
      'could not find `export { ... } from "./kreuzberg_wasm_bg.js";` block in kreuzberg_wasm.js — shim layout may have drifted'
    );
  }
  return new Set(
    match[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith('//'))
  );
}

async function extractNewPublicExports(pkg: string): Promise<Set<string>> {
  const bg = await readFile(`${pkg}/kreuzberg_wasm_bg.js`, 'utf8');
  const names = new Set<string>();
  const re = /^export (?:class|function) ([A-Za-z_][A-Za-z0-9_]*)/gm;
  for (const m of bg.matchAll(re)) {
    const name = m[1];
    // Skip wasm-bindgen internals — the shim only re-exports the public API.
    if (name.startsWith('__wb')) continue;
    names.add(name);
  }
  return names;
}

async function verifyExportParity(pkg: string): Promise<void> {
  const shim = await readFile(fileURLToPath(SHIM_PATH), 'utf8');
  const shimExports = extractShimExports(shim);
  const newExports = await extractNewPublicExports(pkg);

  const added = [...newExports].filter((n) => !shimExports.has(n)).sort();
  const removed = [...shimExports].filter((n) => !newExports.has(n)).sort();

  if (added.length === 0 && removed.length === 0) {
    log(
      `public-API export list unchanged (${shimExports.size} symbols) — shim re-export list needs no edit`
    );
    return;
  }

  process.stderr.write(
    '\n[rebuild-kreuzberg-wasm] ⚠ public-API export list drifted:\n'
  );
  if (added.length) {
    process.stderr.write(`  + added:   ${added.join(', ')}\n`);
  }
  if (removed.length) {
    process.stderr.write(`  - removed: ${removed.join(', ')}\n`);
  }
  process.stderr.write(
    `\nEdit the \`export { ... } from "./kreuzberg_wasm_bg.js";\` block in\n` +
      `  ${fileURLToPath(SHIM_PATH)}\n` +
      'to reflect the new symbol set, then sanity-check src/extract/kreuzberg.ts\n' +
      'still imports existing names (initWasm and extractBytes come from the\n' +
      'upstream dist/index.js wrapper, not from this shim).\n'
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const version = parseVersion(process.argv);
  log(`target @kreuzberg/wasm version: ${version}`);
  await ensureToolchain();
  const wasmCrate = await cloneRepo(version);
  const pkg = await wasmPackBuild(wasmCrate);
  await copyArtifacts(pkg);
  await verifyExportParity(pkg);
  log('done. Next steps:');
  log(`  1. Edit package.json: "@kreuzberg/wasm": "^${version}"`);
  log('  2. bun install   (runs the postinstall patch)');
  log('  3. task check && task compile && ./dist/gdrivescope --version');
  log('  4. bun run scripts/spikes/kreuzberg-compile.ts');
}

await main();

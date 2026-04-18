// Kreuzberg's WASM module leaks noise through three channels:
//
//  1. lopdf's non-fatal xref warnings (e.g. "Size entry of trailer dictionary
//     is 53, correct value is 48.") via wasm-bindgen's __wbg_warn → console.warn.
//     The PDF still parses fine.
//
//  2. Rust panics: console_error_panic_hook::hook prints the full stack via
//     console.error as a side-effect of the unwind, before the JS Error is
//     thrown.
//
//  3. Some panics escape the extractBytes() await chain as detached future
//     rejections and surface as uncaughtException with just the bare
//     RuntimeError.message (no "RuntimeError: " prefix). The affected file
//     is already logged via recordNodeFailure when the top-level promise
//     rejects — the uncaughtException is a duplicate.
//
// All three are filtered with narrow regexes so unrelated traffic (including
// anything from our own code) still reaches stderr.

const WARN_NOISE_PATTERNS: readonly RegExp[] = [
  /^Size entry of trailer dictionary is \d+, correct value is \d+\.?$/,
];

const ERROR_NOISE_PATTERNS: readonly RegExp[] = [
  /^RuntimeError: Unreachable code.*wasm_bindgen__convert__closures/,
];

const UNCAUGHT_NOISE_PATTERNS: readonly RegExp[] = [
  /^Unreachable code should not be executed.*wasm_bindgen__convert__closures/,
];

export type KreuzbergNoiseLevel = 'warn' | 'error' | 'uncaught';

export function isKreuzbergNoise(
  level: KreuzbergNoiseLevel,
  message: string
): boolean {
  const patterns =
    level === 'warn'
      ? WARN_NOISE_PATTERNS
      : level === 'error'
        ? ERROR_NOISE_PATTERNS
        : UNCAUGHT_NOISE_PATTERNS;
  return patterns.some((re) => re.test(message));
}

let installed = false;

export function installWasmConsoleFilter(): void {
  if (installed) return;
  installed = true;
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.warn = (...args: unknown[]): void => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    if (isKreuzbergNoise('warn', first)) return;
    originalWarn(...args);
  };
  console.error = (...args: unknown[]): void => {
    const first = typeof args[0] === 'string' ? args[0] : '';
    if (isKreuzbergNoise('error', first)) return;
    originalError(...args);
  };
}

installWasmConsoleFilter();

import { isKreuzbergNoise } from '../extract/wasm-console-filter.js';
import { error } from './logging.js';

// Kreuzberg leaks some WASM panics outside the extractBytes() await chain
// as detached future rejections. The top-level promise the pipeline awaits
// still rejects — recordNodeFailure already logs that file — but a
// duplicate rejection also surfaces as uncaughtException/unhandledRejection.
// Swallow the duplicate silently so it doesn't fail the run or spam stderr.
// Anything else still gets logged + exit 1.

let installed = false;

export function installProcessHandlers(): void {
  if (installed) return;
  installed = true;
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (isKreuzbergNoise('uncaught', msg)) return;
    error(`unhandled rejection: ${msg}`);
    process.exitCode = 1;
  });
  process.on('uncaughtException', (err) => {
    if (isKreuzbergNoise('uncaught', err.message)) return;
    error(`uncaught exception: ${err.message}`);
    process.exitCode = 1;
  });
}

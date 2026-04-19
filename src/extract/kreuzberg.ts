import { extractBytes, initWasm } from '@kreuzberg/wasm';
import { createSemaphore } from '../pipeline/concurrency.js';
import { CliError } from '../utils/errors.js';
// Side-effect: installs console.warn/console.error filters for Kreuzberg's
// lopdf warnings and panic-hook spam before the first extractBytes() call.
import './wasm-console-filter.js';

let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = initWasm();
  return initPromise;
}

// Concurrent extractBytes() calls into the shared @kreuzberg/wasm instance
// interleave at await points and corrupt the wasm-bindgen externref table /
// linear memory, causing an "Unreachable code should not be executed" trap
// in the extractBytes(ptr0, len0, …, addToExternrefTable0(config)) wrapper.
// Serialize all extraction calls to a single in-flight call at a time.
const extractSem = createSemaphore(1);

export async function extractToMarkdown(
  bytes: Uint8Array,
  mimeType: string
): Promise<string> {
  await ensureInit();
  const release = await extractSem.acquire();
  try {
    const result = await extractBytes(bytes, mimeType, {
      outputFormat: 'markdown',
    });
    return result.content;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `Kreuzberg failed (${mimeType}): ${msg}`,
      'EXTRACT_FAILED'
    );
  } finally {
    release();
  }
}

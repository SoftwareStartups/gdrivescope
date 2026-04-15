import { extractBytes, initWasm } from '@kreuzberg/wasm';
import { CliError } from '../utils/errors.js';

let initPromise: Promise<void> | null = null;
function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = initWasm();
  return initPromise;
}

export async function extractToMarkdown(
  bytes: Uint8Array,
  mimeType: string
): Promise<string> {
  await ensureInit();
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
  }
}

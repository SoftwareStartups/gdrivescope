import { PDFDocument } from 'pdf-lib';
import { CliError } from '../utils/errors.js';

export async function slicePdfToFirstPages(
  bytes: Uint8Array,
  maxPages: number
): Promise<Uint8Array> {
  if (maxPages <= 0) {
    throw new CliError('maxPages must be > 0', 'BAD_ARG');
  }
  let src: PDFDocument;
  try {
    src = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(`pdf-lib load failed: ${msg}`, 'PDF_SLICE_FAILED');
  }
  const total = src.getPageCount();
  if (total <= maxPages) return bytes;

  const dst = await PDFDocument.create();
  const indices = Array.from({ length: maxPages }, (_, i) => i);
  const pages = await dst.copyPages(src, indices);
  for (const page of pages) dst.addPage(page);
  return await dst.save();
}

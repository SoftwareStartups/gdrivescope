import { describe, expect, test } from 'bun:test';
import { PDFDocument } from 'pdf-lib';
import { slicePdfToFirstPages } from '../../src/extract/pdf-slice.js';
import { CliError } from '../../src/utils/errors.js';

async function synthPdf(pageCount: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([200, 200]);
    page.drawText(`page ${i + 1}`, { x: 20, y: 100, size: 12 });
  }
  return doc.save();
}

describe('slicePdfToFirstPages', () => {
  test('reduces a 20-page pdf to 5 pages', async () => {
    const bytes = await synthPdf(20);
    const sliced = await slicePdfToFirstPages(bytes, 5);
    const reloaded = await PDFDocument.load(sliced);
    expect(reloaded.getPageCount()).toBe(5);
    expect(sliced.length).toBeLessThan(bytes.length);
  });

  test('passthrough when total <= maxPages returns original bytes', async () => {
    const bytes = await synthPdf(3);
    const sliced = await slicePdfToFirstPages(bytes, 10);
    // Same reference (no reserialization).
    expect(sliced).toBe(bytes);
  });

  test('maxPages 0 throws BAD_ARG', async () => {
    const bytes = await synthPdf(2);
    try {
      await slicePdfToFirstPages(bytes, 0);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('BAD_ARG');
    }
  });

  test('corrupt input throws PDF_SLICE_FAILED', async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    try {
      await slicePdfToFirstPages(garbage, 3);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('PDF_SLICE_FAILED');
    }
  });
});

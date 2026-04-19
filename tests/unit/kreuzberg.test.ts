import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { extractToMarkdown } from '../../src/extract/kreuzberg.js';
import { CliError } from '../../src/utils/errors.js';

const FIXTURE_PATH = fileURLToPath(
  new URL('../../scripts/spikes/fixtures/sample.pdf', import.meta.url)
);

describe('extractToMarkdown', () => {
  test('extracts known phrase from sample.pdf', async () => {
    const bytes = await Bun.file(FIXTURE_PATH).bytes();
    const markdown = await extractToMarkdown(bytes, 'application/pdf');
    expect(markdown).toContain('gdrivescope');
    expect(markdown).toContain('Kreuzberg');
  });

  test('invalid bytes throw EXTRACT_FAILED', async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02]);
    try {
      await extractToMarkdown(garbage, 'application/pdf');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('EXTRACT_FAILED');
    }
  });

  test('parallel calls all succeed without wasm panic', async () => {
    const bytes = await Bun.file(FIXTURE_PATH).bytes();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        extractToMarkdown(bytes, 'application/pdf')
      )
    );
    for (const md of results) {
      expect(md).toContain('gdrivescope');
    }
  });
});

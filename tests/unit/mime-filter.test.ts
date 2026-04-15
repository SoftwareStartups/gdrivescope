import { describe, expect, test } from 'bun:test';
import { SKIPPED_MIMES, shouldExtract } from '../../src/extract/mime-filter.js';

describe('shouldExtract', () => {
  test.each([
    'application/vnd.google-apps.folder',
    'application/vnd.google-apps.form',
    'application/vnd.google-apps.site',
    'application/vnd.google-apps.map',
    'application/vnd.google-apps.jam',
    'application/vnd.google-apps.shortcut',
  ])('skips %s', (mime) => {
    expect(SKIPPED_MIMES.has(mime)).toBe(true);
    expect(shouldExtract(mime)).toBe(false);
  });

  test.each([
    'image/png',
    'image/jpeg',
    'audio/mpeg',
    'video/mp4',
  ])('skips media type %s', (mime) => {
    expect(shouldExtract(mime)).toBe(false);
  });

  test.each([
    'application/pdf',
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/csv',
  ])('extracts %s', (mime) => {
    expect(shouldExtract(mime)).toBe(true);
  });
});

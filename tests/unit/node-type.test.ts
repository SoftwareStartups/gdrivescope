import { describe, expect, test } from 'bun:test';
import {
  classifyNodeType,
  isNodeType,
  NODE_TYPES,
  type NodeType,
} from '../../src/utils/node-type.js';

const cases: ReadonlyArray<readonly [string, NodeType]> = [
  ['application/vnd.google-apps.folder', 'folder'],
  ['application/vnd.google-apps.shortcut', 'shortcut'],
  ['application/vnd.google-apps.document', 'file'],
  ['application/vnd.google-apps.spreadsheet', 'file'],
  ['application/vnd.google-apps.presentation', 'file'],
  ['application/pdf', 'file'],
  [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'file',
  ],
  ['text/markdown', 'file'],
  ['application/octet-stream', 'file'],
  ['application/vnd.google-apps.form', 'other'],
  ['application/vnd.google-apps.site', 'other'],
  ['application/vnd.google-apps.map', 'other'],
  ['application/vnd.google-apps.jam', 'other'],
  ['image/png', 'other'],
  ['image/jpeg', 'other'],
  ['audio/mp3', 'other'],
  ['video/mp4', 'other'],
];

describe('classifyNodeType', () => {
  for (const [mime, expected] of cases) {
    test(`${mime} → ${expected}`, () => {
      expect(classifyNodeType(mime)).toBe(expected);
    });
  }
});

describe('isNodeType', () => {
  test('accepts every published NODE_TYPES value', () => {
    for (const t of NODE_TYPES) {
      expect(isNodeType(t)).toBe(true);
    }
  });

  test('rejects values outside the union', () => {
    expect(isNodeType('bogus')).toBe(false);
    expect(isNodeType('')).toBe(false);
    expect(isNodeType('FILE')).toBe(false);
  });
});

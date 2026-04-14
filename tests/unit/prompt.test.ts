import { describe, expect, test } from 'bun:test';
import { isTTY } from '../../src/utils/prompt.js';

describe('isTTY', () => {
  test('returns a boolean', () => {
    expect(typeof isTTY()).toBe('boolean');
  });
});

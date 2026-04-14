import { describe, expect, test } from 'bun:test';

describe('scaffolding smoke', () => {
  test('runtime math works', () => {
    expect(2 + 2).toBe(4);
  });
});

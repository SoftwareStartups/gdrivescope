import { describe, expect, test } from 'bun:test';
import { fail, success } from '../../src/models/api-response.js';

describe('success', () => {
  test('wraps data in ok envelope', () => {
    const r = success({ scope: 'x' });
    expect(r).toEqual({ ok: true, data: { scope: 'x' } });
  });

  test('narrows via ok discriminant', () => {
    const r = success('hello');
    if (r.ok) {
      expect(r.data).toBe('hello');
    } else {
      throw new Error('should be ok');
    }
  });
});

describe('fail', () => {
  test('builds error envelope with code', () => {
    const r = fail('boom', 'AUTH_FAILED');
    expect(r).toEqual({ ok: false, error: 'boom', code: 'AUTH_FAILED' });
  });
});

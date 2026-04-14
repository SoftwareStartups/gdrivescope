import { describe, expect, test } from 'bun:test';
import { CliError, toResponse } from '../../src/utils/errors.js';

describe('toResponse', () => {
  test('maps CliError to envelope with code', () => {
    const r = toResponse(new CliError('bad auth', 'AUTH_FAILED'));
    expect(r).toEqual({
      ok: false,
      error: 'bad auth',
      code: 'AUTH_FAILED',
    });
  });

  test('maps plain Error to UNKNOWN', () => {
    const r = toResponse(new Error('boom'));
    expect(r).toEqual({ ok: false, error: 'boom', code: 'UNKNOWN' });
  });

  test('maps non-Error throwable to UNKNOWN', () => {
    const r = toResponse('oops');
    expect(r).toEqual({ ok: false, error: 'oops', code: 'UNKNOWN' });
  });
});

describe('CliError', () => {
  test('carries code and preserves message + name', () => {
    const err = new CliError('msg', 'AUTH_REQUIRED');
    expect(err.message).toBe('msg');
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(err.name).toBe('CliError');
    expect(err).toBeInstanceOf(Error);
  });
});

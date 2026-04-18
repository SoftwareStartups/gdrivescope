import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { resetVaultCache } from '../../src/auth/keychain.js';
import { SCOPE_FULL, SCOPE_METADATA } from '../../src/auth/oauth.js';
import { ensureScope } from '../../src/auth/scopes.js';
import { CliError } from '../../src/utils/errors.js';

function mockVault(raw: string | null): ReturnType<typeof spyOn> {
  resetVaultCache();
  return spyOn(Bun.secrets, 'get').mockResolvedValue(raw);
}

function vaultValue(scope: string): string {
  return JSON.stringify({
    refreshToken: 'r',
    scope,
    obtainedAt: 0,
    clientId: 'id',
    clientSecret: 'secret',
  });
}

describe('ensureScope', () => {
  afterEach(() => {
    resetVaultCache();
  });

  test('throws AUTH_REQUIRED when no vault is present', async () => {
    const spy = mockVault(null);
    try {
      await ensureScope(SCOPE_FULL);
      throw new Error('expected ensureScope to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('AUTH_REQUIRED');
    } finally {
      spy.mockRestore();
    }
  });

  test('throws SCOPE_REQUIRED when the required scope is not granted', async () => {
    const spy = mockVault(vaultValue(SCOPE_METADATA));
    try {
      await ensureScope(SCOPE_FULL);
      throw new Error('expected ensureScope to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('SCOPE_REQUIRED');
      expect((err as CliError).message).toContain('drive.readonly');
    } finally {
      spy.mockRestore();
    }
  });

  test('resolves when the required scope is in a space-separated scope list', async () => {
    const spy = mockVault(vaultValue(`${SCOPE_METADATA} ${SCOPE_FULL}`));
    try {
      await ensureScope(SCOPE_FULL);
    } finally {
      spy.mockRestore();
    }
  });

  test('full scope satisfies a metadata-only requirement (hierarchy)', async () => {
    const spy = mockVault(vaultValue(SCOPE_FULL));
    try {
      await ensureScope(SCOPE_METADATA);
    } finally {
      spy.mockRestore();
    }
  });
});

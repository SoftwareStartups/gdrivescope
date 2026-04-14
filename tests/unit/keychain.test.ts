import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  clearVault,
  getAuth,
  getStoredClientId,
  getStoredClientSecret,
  getVault,
  resetVaultCache,
  setVault,
  type Vault,
} from '../../src/auth/keychain.js';

const SERVICE = 'com.softwarestartups.gdrivescope';
const VAULT_KEY = 'gdrivescope.vault';

const SAMPLE_VAULT: Vault = {
  refreshToken: 'rt-123',
  scope: 'https://www.googleapis.com/auth/drive.metadata.readonly',
  obtainedAt: 1_700_000_000_000,
  clientId: 'cid-1',
  clientSecret: 'csecret-1',
};

describe('keychain vault', () => {
  let getSpy: ReturnType<typeof spyOn>;
  let setSpy: ReturnType<typeof spyOn>;
  let deleteSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getSpy = spyOn(Bun.secrets, 'get');
    setSpy = spyOn(Bun.secrets, 'set');
    deleteSpy = spyOn(Bun.secrets, 'delete');
    resetVaultCache();
  });

  afterEach(() => {
    getSpy.mockRestore();
    setSpy.mockRestore();
    deleteSpy.mockRestore();
    resetVaultCache();
  });

  test('setVault stores a single JSON blob under the vault key', async () => {
    setSpy.mockResolvedValue(undefined);
    await setVault(SAMPLE_VAULT);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(setSpy).toHaveBeenCalledWith({
      service: SERVICE,
      name: VAULT_KEY,
      value: JSON.stringify(SAMPLE_VAULT),
      allowUnrestrictedAccess: true,
    });
  });

  test('getVault round-trips a vault blob', async () => {
    getSpy.mockResolvedValue(JSON.stringify(SAMPLE_VAULT));
    expect(await getVault()).toEqual(SAMPLE_VAULT);
    expect(getSpy).toHaveBeenCalledWith({ service: SERVICE, name: VAULT_KEY });
  });

  test('getVault caches across multiple reads (single keychain hit)', async () => {
    getSpy.mockResolvedValue(JSON.stringify(SAMPLE_VAULT));
    await getVault();
    await getVault();
    await getAuth();
    await getStoredClientId();
    await getStoredClientSecret();
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  test('setVault primes the cache so subsequent reads skip keychain', async () => {
    setSpy.mockResolvedValue(undefined);
    await setVault(SAMPLE_VAULT);
    await getVault();
    await getStoredClientId();
    expect(getSpy).not.toHaveBeenCalled();
  });

  test('getVault returns null when keychain has nothing', async () => {
    getSpy.mockResolvedValue(null);
    expect(await getVault()).toBeNull();
  });

  test('getVault returns null on malformed JSON', async () => {
    getSpy.mockResolvedValue('not-json');
    expect(await getVault()).toBeNull();
  });

  test('getVault returns null on wrong shape', async () => {
    getSpy.mockResolvedValue(JSON.stringify({ foo: 'bar' }));
    expect(await getVault()).toBeNull();
  });

  test('getVault returns null when keychain throws', async () => {
    getSpy.mockRejectedValue(new Error('no entry'));
    expect(await getVault()).toBeNull();
  });

  test('getAuth projects only the auth subset from the vault', async () => {
    getSpy.mockResolvedValue(JSON.stringify(SAMPLE_VAULT));
    expect(await getAuth()).toEqual({
      refreshToken: SAMPLE_VAULT.refreshToken,
      scope: SAMPLE_VAULT.scope,
      obtainedAt: SAMPLE_VAULT.obtainedAt,
    });
  });

  test('getStoredClientId / getStoredClientSecret return vault fields', async () => {
    getSpy.mockResolvedValue(JSON.stringify(SAMPLE_VAULT));
    expect(await getStoredClientId()).toBe(SAMPLE_VAULT.clientId);
    expect(await getStoredClientSecret()).toBe(SAMPLE_VAULT.clientSecret);
  });

  test('getStoredClientId returns null when the vault is empty', async () => {
    getSpy.mockResolvedValue(null);
    expect(await getStoredClientId()).toBeNull();
  });

  test('clearVault deletes the vault key and all legacy entries', async () => {
    deleteSpy.mockResolvedValue(true);
    expect(await clearVault()).toBe(true);
    const names = deleteSpy.mock.calls.map(
      (call) => (call[0] as { name: string }).name
    );
    expect(names).toContain(VAULT_KEY);
    expect(names).toContain('GOOGLE_OAUTH_TOKENS');
    expect(names).toContain('GOOGLE_OAUTH_CLIENT_ID');
    expect(names).toContain('GOOGLE_OAUTH_CLIENT_SECRET');
  });

  test('clearVault returns false when nothing was deleted', async () => {
    deleteSpy.mockResolvedValue(false);
    expect(await clearVault()).toBe(false);
  });

  test('clearVault ignores delete failures', async () => {
    deleteSpy.mockRejectedValue(new Error('no entry'));
    expect(await clearVault()).toBe(false);
  });

  test('clearVault pins the cache to absent without another keychain read', async () => {
    getSpy.mockResolvedValue(JSON.stringify(SAMPLE_VAULT));
    await getVault();
    expect(getSpy).toHaveBeenCalledTimes(1);

    deleteSpy.mockResolvedValue(true);
    await clearVault();

    // Subsequent reads see the cached "gone" state — no extra keychain hit.
    expect(await getVault()).toBeNull();
    expect(getSpy).toHaveBeenCalledTimes(1);
  });
});

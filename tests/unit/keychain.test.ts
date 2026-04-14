import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  clearAuth,
  clearStoredClientCredentials,
  getAuth,
  getStoredClientId,
  getStoredClientSecret,
  setAuth,
  setStoredClientCredentials,
  type StoredAuth,
} from '../../src/auth/keychain.js';

const SERVICE = 'com.softwarestartups.gdrivescope';
const AUTH_KEY = 'GOOGLE_OAUTH_TOKENS';
const CLIENT_ID_KEY = 'GOOGLE_OAUTH_CLIENT_ID';
const CLIENT_SECRET_KEY = 'GOOGLE_OAUTH_CLIENT_SECRET';

describe('keychain auth helpers', () => {
  let getSpy: ReturnType<typeof spyOn>;
  let setSpy: ReturnType<typeof spyOn>;
  let deleteSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getSpy = spyOn(Bun.secrets, 'get');
    setSpy = spyOn(Bun.secrets, 'set');
    deleteSpy = spyOn(Bun.secrets, 'delete');
  });

  afterEach(() => {
    getSpy.mockRestore();
    setSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  test('setAuth stores JSON blob under AUTH_KEY', async () => {
    setSpy.mockResolvedValue(undefined);
    const auth: StoredAuth = {
      refreshToken: 'rt-123',
      scope: 'https://www.googleapis.com/auth/drive.metadata.readonly',
      obtainedAt: 1_700_000_000_000,
    };
    await setAuth(auth);
    expect(setSpy).toHaveBeenCalledWith({
      service: SERVICE,
      name: AUTH_KEY,
      value: JSON.stringify(auth),
      allowUnrestrictedAccess: true,
    });
  });

  test('getAuth round-trips a stored StoredAuth', async () => {
    const auth: StoredAuth = {
      refreshToken: 'rt-123',
      scope: 'scope-x',
      obtainedAt: 42,
    };
    getSpy.mockResolvedValue(JSON.stringify(auth));
    const result = await getAuth();
    expect(result).toEqual(auth);
    expect(getSpy).toHaveBeenCalledWith({
      service: SERVICE,
      name: AUTH_KEY,
    });
  });

  test('getAuth returns null when keychain has nothing', async () => {
    getSpy.mockResolvedValue(null);
    expect(await getAuth()).toBeNull();
  });

  test('getAuth returns null when keychain throws', async () => {
    getSpy.mockRejectedValue(new Error('no entry'));
    expect(await getAuth()).toBeNull();
  });

  test('getAuth returns null on malformed JSON', async () => {
    getSpy.mockResolvedValue('not-json');
    expect(await getAuth()).toBeNull();
  });

  test('getAuth returns null on wrong shape', async () => {
    getSpy.mockResolvedValue(JSON.stringify({ foo: 'bar' }));
    expect(await getAuth()).toBeNull();
  });

  test('clearAuth delegates to deleteSecret', async () => {
    deleteSpy.mockResolvedValue(true);
    expect(await clearAuth()).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith({
      service: SERVICE,
      name: AUTH_KEY,
    });
  });

  test('clearAuth returns false when delete throws', async () => {
    deleteSpy.mockRejectedValue(new Error('no entry'));
    expect(await clearAuth()).toBe(false);
  });
});

describe('keychain client credential helpers', () => {
  let getSpy: ReturnType<typeof spyOn>;
  let setSpy: ReturnType<typeof spyOn>;
  let deleteSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    getSpy = spyOn(Bun.secrets, 'get');
    setSpy = spyOn(Bun.secrets, 'set');
    deleteSpy = spyOn(Bun.secrets, 'delete');
  });

  afterEach(() => {
    getSpy.mockRestore();
    setSpy.mockRestore();
    deleteSpy.mockRestore();
  });

  test('setStoredClientCredentials stores both entries', async () => {
    setSpy.mockResolvedValue(undefined);
    await setStoredClientCredentials('cid-1', 'csecret-1');
    expect(setSpy).toHaveBeenCalledWith({
      service: SERVICE,
      name: CLIENT_ID_KEY,
      value: 'cid-1',
      allowUnrestrictedAccess: true,
    });
    expect(setSpy).toHaveBeenCalledWith({
      service: SERVICE,
      name: CLIENT_SECRET_KEY,
      value: 'csecret-1',
      allowUnrestrictedAccess: true,
    });
  });

  test('getStoredClientId returns stored value', async () => {
    getSpy.mockResolvedValue('cid-1');
    expect(await getStoredClientId()).toBe('cid-1');
    expect(getSpy).toHaveBeenCalledWith({
      service: SERVICE,
      name: CLIENT_ID_KEY,
    });
  });

  test('getStoredClientSecret returns stored value', async () => {
    getSpy.mockResolvedValue('csecret-1');
    expect(await getStoredClientSecret()).toBe('csecret-1');
    expect(getSpy).toHaveBeenCalledWith({
      service: SERVICE,
      name: CLIENT_SECRET_KEY,
    });
  });

  test('getStoredClientId returns null when keychain throws', async () => {
    getSpy.mockRejectedValue(new Error('no entry'));
    expect(await getStoredClientId()).toBeNull();
  });

  test('clearStoredClientCredentials returns true if at least one deleted', async () => {
    deleteSpy.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await clearStoredClientCredentials()).toBe(true);
    expect(deleteSpy).toHaveBeenCalledTimes(2);
  });

  test('clearStoredClientCredentials returns false when nothing deleted', async () => {
    deleteSpy.mockResolvedValue(false);
    expect(await clearStoredClientCredentials()).toBe(false);
  });
});

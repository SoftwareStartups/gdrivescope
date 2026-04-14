import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { resolveClientCredentials } from '../../src/auth/credentials.js';
import { resetVaultCache, type Vault } from '../../src/auth/keychain.js';
import { CliError } from '../../src/utils/errors.js';

function vaultJson(overrides: Partial<Vault> = {}): string {
  const vault: Vault = {
    refreshToken: 'rt',
    scope: 'scope',
    obtainedAt: 0,
    clientId: 'keychain-val',
    clientSecret: 'keychain-val',
    ...overrides,
  };
  return JSON.stringify(vault);
}

describe('resolveClientCredentials', () => {
  let getSpy: ReturnType<typeof spyOn>;
  const ORIG_ID = Bun.env.GOOGLE_OAUTH_CLIENT_ID;
  const ORIG_SECRET = Bun.env.GOOGLE_OAUTH_CLIENT_SECRET;

  beforeEach(() => {
    getSpy = spyOn(Bun.secrets, 'get');
    delete Bun.env.GOOGLE_OAUTH_CLIENT_ID;
    delete Bun.env.GOOGLE_OAUTH_CLIENT_SECRET;
    resetVaultCache();
  });

  afterEach(() => {
    getSpy.mockRestore();
    resetVaultCache();
    if (ORIG_ID !== undefined) Bun.env.GOOGLE_OAUTH_CLIENT_ID = ORIG_ID;
    if (ORIG_SECRET !== undefined)
      Bun.env.GOOGLE_OAUTH_CLIENT_SECRET = ORIG_SECRET;
  });

  const neverPrompt = async (): Promise<string> => {
    throw new Error('prompt should not be called');
  };

  test('flags win over env and keychain', async () => {
    Bun.env.GOOGLE_OAUTH_CLIENT_ID = 'env-id';
    Bun.env.GOOGLE_OAUTH_CLIENT_SECRET = 'env-secret';
    getSpy.mockResolvedValue(vaultJson());
    const result = await resolveClientCredentials(
      {
        flags: { clientId: 'flag-id', clientSecret: 'flag-secret' },
        interactive: false,
      },
      neverPrompt
    );
    expect(result).toEqual({
      clientId: 'flag-id',
      clientSecret: 'flag-secret',
    });
  });

  test('env wins over keychain', async () => {
    Bun.env.GOOGLE_OAUTH_CLIENT_ID = 'env-id';
    Bun.env.GOOGLE_OAUTH_CLIENT_SECRET = 'env-secret';
    getSpy.mockResolvedValue(vaultJson());
    const result = await resolveClientCredentials(
      { flags: {}, interactive: false },
      neverPrompt
    );
    expect(result).toEqual({
      clientId: 'env-id',
      clientSecret: 'env-secret',
    });
  });

  test('keychain used when flags and env absent', async () => {
    getSpy.mockResolvedValue(
      vaultJson({ clientId: 'keychain-val', clientSecret: 'keychain-val' })
    );
    const result = await resolveClientCredentials(
      { flags: {}, interactive: false },
      neverPrompt
    );
    expect(result).toEqual({
      clientId: 'keychain-val',
      clientSecret: 'keychain-val',
    });
  });

  test('non-interactive with nothing throws AUTH_REQUIRED', async () => {
    getSpy.mockResolvedValue(null);
    try {
      await resolveClientCredentials(
        { flags: {}, interactive: false },
        neverPrompt
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('AUTH_REQUIRED');
    }
  });

  test('interactive prompts for both missing values', async () => {
    getSpy.mockResolvedValue(null);
    const labels: string[] = [];
    const fakePrompt = async (label: string): Promise<string> => {
      labels.push(label);
      return label.includes('id') ? 'typed-id' : 'typed-secret';
    };
    const result = await resolveClientCredentials(
      { flags: {}, interactive: true },
      fakePrompt
    );
    expect(result).toEqual({
      clientId: 'typed-id',
      clientSecret: 'typed-secret',
    });
    expect(labels).toHaveLength(2);
  });

  test('interactive only prompts for missing field', async () => {
    Bun.env.GOOGLE_OAUTH_CLIENT_ID = 'env-id';
    getSpy.mockResolvedValue(null);
    const labels: string[] = [];
    const fakePrompt = async (label: string): Promise<string> => {
      labels.push(label);
      return 'typed-secret';
    };
    const result = await resolveClientCredentials(
      { flags: {}, interactive: true },
      fakePrompt
    );
    expect(result).toEqual({
      clientId: 'env-id',
      clientSecret: 'typed-secret',
    });
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain('secret');
  });

  test('sanitizes credentials (trims whitespace)', async () => {
    const result = await resolveClientCredentials(
      {
        flags: { clientId: '  flag-id  ', clientSecret: 'flag-secret' },
        interactive: false,
      },
      neverPrompt
    );
    expect(result.clientId).toBe('flag-id');
  });

  test('rejects empty credential from prompt', async () => {
    getSpy.mockResolvedValue(null);
    const emptyPrompt = async (): Promise<string> => '   ';
    try {
      await resolveClientCredentials(
        { flags: {}, interactive: true },
        emptyPrompt
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('AUTH_FAILED');
    }
  });
});

const SERVICE = 'com.softwarestartups.gdrivescope';
const VAULT_KEY = 'gdrivescope.vault';

// Legacy keys — used only for cleanup in logout to remove stale entries from
// older pre-vault installs. No code path reads them.
const LEGACY_AUTH_KEY = 'GOOGLE_OAUTH_TOKENS';
const LEGACY_CLIENT_ID_KEY = 'GOOGLE_OAUTH_CLIENT_ID';
const LEGACY_CLIENT_SECRET_KEY = 'GOOGLE_OAUTH_CLIENT_SECRET';

export interface StoredAuth {
  refreshToken: string;
  scope: string;
  obtainedAt: number;
}

export interface Vault extends StoredAuth {
  clientId: string;
  clientSecret: string;
}

let cache: Vault | null | undefined;

function isVault(value: unknown): value is Vault {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.refreshToken === 'string' &&
    typeof v.scope === 'string' &&
    typeof v.obtainedAt === 'number' &&
    typeof v.clientId === 'string' &&
    typeof v.clientSecret === 'string'
  );
}

export async function getVault(): Promise<Vault | null> {
  if (cache !== undefined) return cache;
  try {
    const raw = await Bun.secrets.get({ service: SERVICE, name: VAULT_KEY });
    if (!raw) {
      cache = null;
      return null;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isVault(parsed)) {
      cache = null;
      return null;
    }
    cache = parsed;
    return parsed;
  } catch {
    cache = null;
    return null;
  }
}

export async function setVault(vault: Vault): Promise<void> {
  await Bun.secrets.set({
    service: SERVICE,
    name: VAULT_KEY,
    value: JSON.stringify(vault),
    allowUnrestrictedAccess: true,
  });
  cache = vault;
}

export async function clearVault(): Promise<boolean> {
  cache = null;
  let cleared = false;
  try {
    cleared = (await Bun.secrets.delete({ service: SERVICE, name: VAULT_KEY }))
      ? true
      : cleared;
  } catch {
    // ignore
  }
  // Best-effort cleanup of legacy entries from pre-vault installs. Uses
  // delete-only — never reads — so the user isn't prompted.
  for (const name of [
    LEGACY_AUTH_KEY,
    LEGACY_CLIENT_ID_KEY,
    LEGACY_CLIENT_SECRET_KEY,
  ]) {
    try {
      if (await Bun.secrets.delete({ service: SERVICE, name })) {
        cleared = true;
      }
    } catch {
      // ignore
    }
  }
  return cleared;
}

export function resetVaultCache(): void {
  cache = undefined;
}

export async function getAuth(): Promise<StoredAuth | null> {
  const vault = await getVault();
  if (!vault) return null;
  const { refreshToken, scope, obtainedAt } = vault;
  return { refreshToken, scope, obtainedAt };
}

export async function getStoredClientId(): Promise<string | null> {
  const vault = await getVault();
  return vault?.clientId ?? null;
}

export async function getStoredClientSecret(): Promise<string | null> {
  const vault = await getVault();
  return vault?.clientSecret ?? null;
}

// biome-ignore lint/complexity/useRegexLiterals: RegExp constructor avoids biome noControlCharactersInRegex false positive
const CONTROL_CHARS = new RegExp('[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]');

function hasControlCharacters(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

export function sanitizeCredential(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Credential cannot be empty');
  if (trimmed.length > 4096)
    throw new Error('Credential exceeds maximum length');
  if (hasControlCharacters(trimmed))
    throw new Error('Credential contains invalid control characters');
  return trimmed;
}

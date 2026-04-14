const SERVICE = 'com.softwarestartups.gdrivescope';
const AUTH_KEY = 'GOOGLE_OAUTH_TOKENS';
const CLIENT_ID_KEY = 'GOOGLE_OAUTH_CLIENT_ID';
const CLIENT_SECRET_KEY = 'GOOGLE_OAUTH_CLIENT_SECRET';

export interface StoredAuth {
  refreshToken: string;
  scope: string;
  obtainedAt: number;
}

export async function getSecret(name: string): Promise<string | null> {
  try {
    return await Bun.secrets.get({ service: SERVICE, name });
  } catch {
    return null;
  }
}

export async function setSecret(name: string, value: string): Promise<void> {
  await Bun.secrets.set({
    service: SERVICE,
    name,
    value,
    allowUnrestrictedAccess: true,
  });
}

export async function deleteSecret(name: string): Promise<boolean> {
  try {
    return await Bun.secrets.delete({ service: SERVICE, name });
  } catch {
    return false;
  }
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

export async function getAuth(): Promise<StoredAuth | null> {
  const raw = await getSecret(AUTH_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredAuth;
    if (
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.scope !== 'string' ||
      typeof parsed.obtainedAt !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function setAuth(auth: StoredAuth): Promise<void> {
  await setSecret(AUTH_KEY, JSON.stringify(auth));
}

export async function clearAuth(): Promise<boolean> {
  return deleteSecret(AUTH_KEY);
}

export async function getStoredClientId(): Promise<string | null> {
  return getSecret(CLIENT_ID_KEY);
}

export async function getStoredClientSecret(): Promise<string | null> {
  return getSecret(CLIENT_SECRET_KEY);
}

export async function setStoredClientCredentials(
  clientId: string,
  clientSecret: string
): Promise<void> {
  await setSecret(CLIENT_ID_KEY, clientId);
  await setSecret(CLIENT_SECRET_KEY, clientSecret);
}

export async function clearStoredClientCredentials(): Promise<boolean> {
  const a = await deleteSecret(CLIENT_ID_KEY);
  const b = await deleteSecret(CLIENT_SECRET_KEY);
  return a || b;
}

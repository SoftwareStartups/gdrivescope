import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { authorize, SCOPE_METADATA } from '../../auth/oauth.js';
import { setAuth, setStoredClientCredentials } from '../../auth/keychain.js';
import { resolveClientCredentials } from '../../auth/credentials.js';
import { toResponse } from '../../utils/errors.js';

export interface LoginFlags {
  'client-id'?: string;
  'client-secret'?: string;
}

export interface LoginData {
  scope: string;
}

export const HELP = `gdrivescope login — Authorize with Google Drive

Runs a loopback OAuth 2.0 + PKCE flow: opens your browser, asks you to grant
read-only Drive metadata access, then stores the refresh token in the OS
keychain (service: com.softwarestartups.gdrivescope).

Usage:
  gdrivescope login [--client-id <id>] [--client-secret <secret>] [--json]

Options:
  --client-id <id>         Google OAuth client id
  --client-secret <secret> Google OAuth client secret
  --json                   Emit JSON envelope instead of human-readable output

Credential resolution (in order):
  1. --client-id / --client-secret flags
  2. GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET environment variables
  3. OS keychain (populated by a previous login)
  4. Interactive hidden-input prompt (TTY only)

After a successful login both values are cached in the OS keychain, so
subsequent runs and token refreshes don't need to re-enter them. Create a
Desktop OAuth client at https://console.cloud.google.com/apis/credentials
to obtain client id and secret.
`;

export async function run(flags: LoginFlags): Promise<ApiResponse<LoginData>> {
  try {
    const credentials = await resolveClientCredentials({
      flags: {
        clientId: flags['client-id'],
        clientSecret: flags['client-secret'],
      },
      interactive: true,
    });
    await setStoredClientCredentials(
      credentials.clientId,
      credentials.clientSecret
    );
    const result = await authorize(SCOPE_METADATA, credentials);
    const scope = result.scope || SCOPE_METADATA;
    await setAuth({
      refreshToken: result.refreshToken,
      scope,
      obtainedAt: Date.now(),
    });
    return success({ scope });
  } catch (err) {
    return toResponse(err);
  }
}

export function render(data: LoginData): string {
  return `Signed in. Scope: ${data.scope}`;
}

import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { SCOPE_FULL, SCOPE_METADATA, authorize } from '../../auth/oauth.js';
import { setVault } from '../../auth/keychain.js';
import { resolveClientCredentials } from '../../auth/credentials.js';
import { CliError, toResponse } from '../../utils/errors.js';

export interface LoginFlags {
  'client-id'?: string;
  'client-secret'?: string;
  scope?: string;
}

const SCOPE_ALIASES: Record<string, string> = {
  'drive.metadata.readonly': SCOPE_METADATA,
  'drive.readonly': SCOPE_FULL,
};

function resolveScope(raw: string | undefined): string {
  if (raw === undefined) return SCOPE_METADATA;
  const mapped = SCOPE_ALIASES[raw];
  if (mapped) return mapped;
  if (raw.startsWith('https://www.googleapis.com/auth/')) return raw;
  throw new CliError(
    `Unknown --scope value: ${raw}. Use drive.metadata.readonly or drive.readonly.`,
    'USAGE'
  );
}

export interface LoginData {
  scope: string;
}

export const HELP = `gdrivescope login — Authorize with Google Drive

Runs a loopback OAuth 2.0 + PKCE flow: opens your browser, asks you to grant
read-only Drive metadata access, then stores the refresh token and client
credentials together in a single OS keychain entry (service:
com.softwarestartups.gdrivescope, key: gdrivescope.vault).

Usage:
  gdrivescope login [--client-id <id>] [--client-secret <secret>] [--scope <name>] [--json]

Options:
  --client-id <id>         Google OAuth client id
  --client-secret <secret> Google OAuth client secret
  --scope <name>           drive.metadata.readonly (default) or drive.readonly
  --json                   Emit JSON envelope instead of human-readable output

Credential resolution (in order):
  1. --client-id / --client-secret flags
  2. GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET environment variables
  3. OS keychain (populated by a previous login)
  4. Interactive hidden-input prompt (TTY only)

Create a Desktop OAuth client at
https://console.cloud.google.com/apis/credentials to obtain a client id and
secret.
`;

export async function run(flags: LoginFlags): Promise<ApiResponse<LoginData>> {
  try {
    const requestedScope = resolveScope(flags.scope);
    const credentials = await resolveClientCredentials({
      flags: {
        clientId: flags['client-id'],
        clientSecret: flags['client-secret'],
      },
      interactive: true,
    });
    const result = await authorize(requestedScope, credentials);
    const scope = result.scope || requestedScope;
    await setVault({
      refreshToken: result.refreshToken,
      scope,
      obtainedAt: Date.now(),
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
    });
    return success({ scope });
  } catch (err) {
    return toResponse(err);
  }
}

export function render(data: LoginData): string {
  return `Signed in. Scope: ${data.scope}`;
}

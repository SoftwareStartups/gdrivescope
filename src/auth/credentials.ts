import { CliError } from '../utils/errors.js';
import { promptHidden } from '../utils/prompt.js';
import {
  getStoredClientId,
  getStoredClientSecret,
  sanitizeCredential,
} from './keychain.js';
import type { OAuthCredentials } from './oauth.js';

export interface ClientCredentialFlags {
  clientId?: string;
  clientSecret?: string;
}

export interface ResolveOptions {
  flags: ClientCredentialFlags;
  interactive: boolean;
}

export type Prompter = (label: string) => Promise<string>;

export async function resolveClientCredentials(
  opts: ResolveOptions,
  prompt: Prompter = promptHidden
): Promise<OAuthCredentials> {
  const clientId = await resolveField(
    'clientId',
    'GOOGLE_OAUTH_CLIENT_ID',
    'Google OAuth client id: ',
    opts.flags.clientId,
    getStoredClientId,
    opts.interactive,
    prompt
  );
  const clientSecret = await resolveField(
    'clientSecret',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'Google OAuth client secret: ',
    opts.flags.clientSecret,
    getStoredClientSecret,
    opts.interactive,
    prompt
  );
  return { clientId, clientSecret };
}

async function resolveField(
  _fieldName: string,
  envVar: string,
  promptLabel: string,
  flagValue: string | undefined,
  fromKeychain: () => Promise<string | null>,
  interactive: boolean,
  prompt: Prompter
): Promise<string> {
  const raw =
    flagValue ??
    Bun.env[envVar] ??
    (await fromKeychain()) ??
    (interactive ? await prompt(promptLabel) : undefined);

  if (raw === undefined || raw === null) {
    throw new CliError(
      'Missing OAuth client credentials. Run `gdrivescope login` to set them.',
      'AUTH_REQUIRED'
    );
  }

  try {
    return sanitizeCredential(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid credential';
    throw new CliError(`Invalid ${envVar}: ${msg}`, 'AUTH_FAILED');
  }
}

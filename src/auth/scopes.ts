import { CliError } from '../utils/errors.js';
import { getAuth } from './keychain.js';
import { SCOPE_FULL, SCOPE_METADATA } from './oauth.js';

export const SCOPE_METADATA_READONLY = SCOPE_METADATA;
export const SCOPE_READONLY = SCOPE_FULL;

const SHORT_NAMES: Record<string, string> = {
  [SCOPE_METADATA]: 'drive.metadata.readonly',
  [SCOPE_FULL]: 'drive.readonly',
};

export async function ensureScope(required: string): Promise<void> {
  const auth = await getAuth();
  if (!auth) {
    throw new CliError('Run `gdrivescope login` first.', 'AUTH_REQUIRED');
  }
  const granted = auth.scope.split(/\s+/).filter(Boolean);
  if (!granted.includes(required)) {
    const short = SHORT_NAMES[required] ?? required;
    throw new CliError(
      `This command needs ${short}. Re-run \`gdrivescope login --scope ${short}\`.`,
      'SCOPE_REQUIRED'
    );
  }
}

import { CliError } from '../utils/errors.js';
import { getAuth } from './keychain.js';
import { SCOPE_FULL, SCOPE_METADATA } from './oauth.js';

export const SCOPE_METADATA_READONLY = SCOPE_METADATA;
export const SCOPE_READONLY = SCOPE_FULL;

const SHORT_NAMES: Record<string, string> = {
  [SCOPE_METADATA]: 'drive.metadata.readonly',
  [SCOPE_FULL]: 'drive.readonly',
};

// One-directional hierarchy: the full readonly scope also covers everything
// the metadata-only scope grants, so a session authorized for `drive.readonly`
// does not need to re-login to run metadata-only flows. The reverse does not
// hold — narrower scopes never satisfy broader requirements.
const IMPLIES: Record<string, readonly string[]> = {
  [SCOPE_FULL]: [SCOPE_METADATA],
};

function satisfies(granted: readonly string[], required: string): boolean {
  if (granted.includes(required)) return true;
  for (const g of granted) {
    if (IMPLIES[g]?.includes(required)) return true;
  }
  return false;
}

export async function ensureScope(required: string): Promise<void> {
  const auth = await getAuth();
  if (!auth) {
    throw new CliError('Run `gdrivescope login` first.', 'AUTH_REQUIRED');
  }
  const granted = auth.scope.split(/\s+/).filter(Boolean);
  if (satisfies(granted, required)) return;
  const short = SHORT_NAMES[required] ?? required;
  throw new CliError(
    `This command needs ${short}. Re-run \`gdrivescope login --scope ${short}\`.`,
    'SCOPE_REQUIRED'
  );
}

import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { clearVault } from '../../auth/keychain.js';
import { toResponse } from '../../utils/errors.js';

export interface LogoutData {
  cleared: boolean;
}

export const HELP = `gdrivescope logout — Clear stored credentials

Removes the Drive refresh token and OAuth client credentials from the OS
keychain (service: com.softwarestartups.gdrivescope). Also cleans up any
legacy pre-vault entries left over from earlier versions.

Usage:
  gdrivescope logout [--json]

Options:
  --json           Emit JSON envelope instead of human-readable output
`;

export async function run(): Promise<ApiResponse<LogoutData>> {
  try {
    const cleared = await clearVault();
    return success({ cleared });
  } catch (err) {
    return toResponse(err);
  }
}

export function render(data: LogoutData): string {
  return data.cleared ? 'Credentials cleared.' : 'No stored credentials found.';
}

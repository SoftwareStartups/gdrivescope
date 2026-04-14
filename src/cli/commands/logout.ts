import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { clearAuth } from '../../auth/keychain.js';
import { toResponse } from '../../utils/errors.js';

export interface LogoutData {
  cleared: boolean;
}

export const HELP = `gdrivescope logout — Clear stored credentials

Removes the Google Drive refresh token from the OS keychain (service:
com.softwarestartups.gdrivescope). Stored OAuth client id / secret are
left in place so you don't have to re-enter them on the next login.

Usage:
  gdrivescope logout [--json]

Options:
  --json           Emit JSON envelope instead of human-readable output
`;

export async function run(): Promise<ApiResponse<LogoutData>> {
  try {
    const cleared = await clearAuth();
    return success({ cleared });
  } catch (err) {
    return toResponse(err);
  }
}

export function render(data: LogoutData): string {
  return data.cleared ? 'Credentials cleared.' : 'No stored credentials found.';
}

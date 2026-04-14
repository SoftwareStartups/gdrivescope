import { drive, type drive_v3 } from '@googleapis/drive';
import { OAuth2Client } from 'google-auth-library';
import {
  getAuth,
  getStoredClientId,
  getStoredClientSecret,
} from '../auth/keychain.js';
import { refreshAccessToken } from '../auth/oauth.js';
import { CliError } from '../utils/errors.js';

const AUTH_REQUIRED_MSG = 'Run `gdrivescope login` first.';

export async function createDriveClient(): Promise<drive_v3.Drive> {
  const auth = await getAuth();
  if (!auth) {
    throw new CliError(AUTH_REQUIRED_MSG, 'AUTH_REQUIRED');
  }
  const clientId =
    Bun.env.GOOGLE_OAUTH_CLIENT_ID ?? (await getStoredClientId());
  const clientSecret =
    Bun.env.GOOGLE_OAUTH_CLIENT_SECRET ?? (await getStoredClientSecret());
  if (!clientId || !clientSecret) {
    throw new CliError(AUTH_REQUIRED_MSG, 'AUTH_REQUIRED');
  }
  const refresh = await refreshAccessToken(auth.refreshToken, {
    clientId,
    clientSecret,
  });
  const oauth2Client = new OAuth2Client(clientId, clientSecret);
  oauth2Client.setCredentials({ access_token: refresh.accessToken });
  return drive({ version: 'v3', auth: oauth2Client });
}

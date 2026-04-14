import { drive, type drive_v3 } from '@googleapis/drive';
import { OAuth2Client } from 'google-auth-library';
import { getVault } from '../auth/keychain.js';
import { refreshAccessToken } from '../auth/oauth.js';
import { CliError } from '../utils/errors.js';

const AUTH_REQUIRED_MSG = 'Run `gdrivescope login` first.';

export async function createDriveClient(): Promise<drive_v3.Drive> {
  const vault = await getVault();
  if (!vault) {
    throw new CliError(AUTH_REQUIRED_MSG, 'AUTH_REQUIRED');
  }
  const clientId = Bun.env.GOOGLE_OAUTH_CLIENT_ID ?? vault.clientId;
  const clientSecret = Bun.env.GOOGLE_OAUTH_CLIENT_SECRET ?? vault.clientSecret;
  const refresh = await refreshAccessToken(vault.refreshToken, {
    clientId,
    clientSecret,
  });
  const oauth2Client = new OAuth2Client(clientId, clientSecret);
  oauth2Client.setCredentials({ access_token: refresh.accessToken });
  return drive({ version: 'v3', auth: oauth2Client });
}

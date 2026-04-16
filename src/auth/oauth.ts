import { CliError } from '../utils/errors.js';

export const SCOPE_METADATA =
  'https://www.googleapis.com/auth/drive.metadata.readonly';
export const SCOPE_FULL = 'https://www.googleapis.com/auth/drive.readonly';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface AuthResult {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  scope: string;
}

export interface RefreshResult {
  accessToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

interface CallbackPayload {
  code: string;
  redirectUri: string;
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return base64UrlEncode(new Uint8Array(digest));
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // Fall through — the URL is also printed to stderr.
  }
}

async function exchangeCode(
  credentials: OAuthCredentials,
  params: { code: string; verifier: string; redirectUri: string }
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code: params.code,
    code_verifier: params.verifier,
    grant_type: 'authorization_code',
    redirect_uri: params.redirectUri,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const body = await res.text();
    if (Bun.env.DEBUG) {
      process.stderr.write(`[debug] token endpoint response: ${body}\n`);
    }
    throw new CliError(
      `Token exchange failed (HTTP ${res.status}). Run with DEBUG=1 for details.`,
      'AUTH_FAILED'
    );
  }
  return (await res.json()) as TokenResponse;
}

function awaitCallback(
  credentials: OAuthCredentials,
  scope: string,
  expectedState: string,
  challenge: string
): Promise<CallbackPayload> {
  return new Promise<CallbackPayload>((resolve, reject) => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== '/oauth2callback') {
          return new Response('not found', { status: 404 });
        }
        const error = url.searchParams.get('error');
        if (error) {
          const safeError = error.slice(0, 64).replace(/[^\w_-]/g, '_');
          reject(new CliError(`OAuth error: ${safeError}`, 'AUTH_FAILED'));
          setTimeout(() => server.stop(true), 50);
          return new Response(`Authorization failed: ${error}`, {
            status: 400,
          });
        }
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        if (!code || !returnedState) {
          reject(new CliError('missing code/state on callback', 'AUTH_FAILED'));
          setTimeout(() => server.stop(true), 50);
          return new Response('missing code or state', { status: 400 });
        }
        if (returnedState !== expectedState) {
          reject(new CliError('state mismatch — possible CSRF', 'AUTH_FAILED'));
          setTimeout(() => server.stop(true), 50);
          return new Response('state mismatch', { status: 400 });
        }
        resolve({ code, redirectUri });
        setTimeout(() => server.stop(true), 100);
        return new Response(
          '<html><body><h2>gdrivescope: authorization complete</h2><p>You can close this tab.</p></body></html>',
          { headers: { 'content-type': 'text/html' } }
        );
      },
    });

    const redirectUri = `http://127.0.0.1:${server.port}/oauth2callback`;
    const authUrl = new URL(AUTH_ENDPOINT);
    authUrl.searchParams.set('client_id', credentials.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('state', expectedState);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    process.stderr.write(`gdrivescope: listening on ${redirectUri}\n`);
    process.stderr.write(
      `gdrivescope: opening browser — if it does not open, visit:\n${authUrl.toString()}\n`
    );
    openBrowser(authUrl.toString());
  });
}

export async function authorize(
  scope: string,
  credentials: OAuthCredentials
): Promise<AuthResult> {
  const verifier = randomToken();
  const challenge = await pkceChallenge(verifier);
  const state = randomToken();

  const { code, redirectUri } = await awaitCallback(
    credentials,
    scope,
    state,
    challenge
  );
  const tokens = await exchangeCode(credentials, {
    code,
    verifier,
    redirectUri,
  });

  if (!tokens.refresh_token) {
    throw new CliError(
      'No refresh_token returned. Revoke prior access at https://myaccount.google.com/permissions and run login again.',
      'AUTH_FAILED'
    );
  }

  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope,
  };
}

export async function refreshAccessToken(
  refreshToken: string,
  credentials: OAuthCredentials
): Promise<RefreshResult> {
  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const body = await res.text();
    if (Bun.env.DEBUG) {
      process.stderr.write(`[debug] token refresh response: ${body}\n`);
    }
    throw new CliError(
      `Token refresh failed (HTTP ${res.status}). Run with DEBUG=1 for details.`,
      'AUTH_FAILED'
    );
  }
  const tokens = (await res.json()) as TokenResponse;
  return {
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

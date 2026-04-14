#!/usr/bin/env bun
// Spike: Google OAuth loopback 127.0.0.1 + PKCE flow.
// Spins a short-lived Bun.serve on an ephemeral port, opens the browser,
// exchanges the code for tokens, prints tokens to STDERR only, and exits.
//
// Stage 2 will lift most of this logic into src/auth/oauth.ts verbatim.
//
// Required env:
//   GOOGLE_OAUTH_CLIENT_ID
//   GOOGLE_OAUTH_CLIENT_SECRET

const CLIENT_ID = Bun.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = Bun.env.GOOGLE_OAUTH_CLIENT_SECRET;
const SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

if (!CLIENT_ID || !CLIENT_SECRET) {
  process.stderr.write(
    'spike: GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set\n'
  );
  process.exit(2);
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
    // Fall through — we've printed the URL above.
  }
}

async function exchangeCode(params: {
  code: string;
  verifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID as string,
    client_secret: CLIENT_SECRET as string,
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
    throw new Error(`token endpoint ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

function awaitCallback(expectedState: string): Promise<CallbackPayload> {
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
          reject(new Error(`oauth error: ${error}`));
          setTimeout(() => server.stop(true), 50);
          return new Response(`Authorization failed: ${error}`, {
            status: 400,
          });
        }
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        if (!code || !returnedState) {
          reject(new Error('missing code/state on callback'));
          setTimeout(() => server.stop(true), 50);
          return new Response('missing code or state', { status: 400 });
        }
        if (returnedState !== expectedState) {
          reject(new Error('state mismatch — possible CSRF'));
          setTimeout(() => server.stop(true), 50);
          return new Response('state mismatch', { status: 400 });
        }
        resolve({ code, redirectUri });
        setTimeout(() => server.stop(true), 100);
        return new Response(
          '<html><body><h2>gdrivescope spike: authorization complete</h2><p>You can close this tab.</p></body></html>',
          { headers: { 'content-type': 'text/html' } }
        );
      },
    });

    const redirectUri = `http://127.0.0.1:${server.port}/oauth2callback`;
    const authUrl = new URL(AUTH_ENDPOINT);
    authUrl.searchParams.set('client_id', CLIENT_ID as string);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPE);
    authUrl.searchParams.set('state', expectedState);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');

    process.stderr.write(`spike: listening on ${redirectUri}\n`);
    process.stderr.write(
      `spike: opening browser — if it does not open, visit:\n${authUrl.toString()}\n`
    );
    openBrowser(authUrl.toString());
  });
}

const verifier = randomToken();
const challenge = await pkceChallenge(verifier);
const state = randomToken();

const { code, redirectUri } = await awaitCallback(state);
process.stderr.write('spike: received code, exchanging…\n');

const tokens = await exchangeCode({ code, verifier, redirectUri });
process.stderr.write(
  `spike: OK — access_token(prefix)=${tokens.access_token.slice(0, 12)}…, ` +
    `refresh_token=${tokens.refresh_token ? 'present' : 'MISSING'}, ` +
    `expires_in=${tokens.expires_in}s, scope=${tokens.scope}\n`
);
process.stdout.write(
  `${JSON.stringify({ ok: true, data: { hasRefresh: Boolean(tokens.refresh_token), expires_in: tokens.expires_in, scope: tokens.scope } })}\n`
);

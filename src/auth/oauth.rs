//! OAuth 2.0 + PKCE loopback flow against Google.
//!
//! The loopback server is tiny: `tokio::net::TcpListener` accepts the
//! single-shot redirect from the user's browser, parses one HTTP request
//! by hand, and hands the authorization code to `reqwest` for the token
//! POST. No yup-oauth2 dependency — its `TokenStorage` trait would force a
//! wrapper around our `Vault` that's bigger than this whole module.

use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::error::{CliError, ErrorCode};

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

#[derive(Debug, Clone)]
pub struct OAuthCredentials {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Debug, Clone)]
pub struct AuthResult {
    pub refresh_token: String,
    pub access_token: String,
    /// Milliseconds since UNIX epoch.
    pub expires_at: i64,
    pub scope: String,
}

#[derive(Debug, Clone)]
pub struct RefreshResult {
    pub access_token: String,
    pub expires_at: i64,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
    refresh_token: Option<String>,
    scope: String,
    #[allow(dead_code)]
    token_type: String,
}

/// Run the full PKCE loopback flow.
pub async fn authorize(scope: &str, creds: &OAuthCredentials) -> Result<AuthResult, CliError> {
    let verifier = random_token();
    let challenge = pkce_challenge(&verifier);
    let state = random_token();

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| CliError::new(format!("loopback bind: {e}"), ErrorCode::AuthFailed))?;
    let port = listener
        .local_addr()
        .map_err(|e| CliError::new(format!("loopback addr: {e}"), ErrorCode::AuthFailed))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth2callback");

    let mut auth_url = url::Url::parse(AUTH_ENDPOINT).expect("static endpoint URL parses");
    auth_url
        .query_pairs_mut()
        .append_pair("client_id", &creds.client_id)
        .append_pair("redirect_uri", &redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", scope)
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");

    eprintln!("gdrivescope: listening on {redirect_uri}");
    if is_wsl() {
        // No usable browser launcher on WSL; auto-open just errors or stalls.
        // The Windows browser reaches this loopback listener via WSL2's
        // default localhost forwarding, so the manual paste flow works.
        eprintln!(
            "gdrivescope: open this URL in your browser, then approve:\n{}\n\
             gdrivescope: it will redirect to {redirect_uri}, captured on this machine.",
            auth_url.as_str(),
        );
    } else {
        eprintln!(
            "gdrivescope: opening browser — if it does not open, visit:\n{}",
            auth_url.as_str(),
        );
        // Best-effort; the URL is also printed to stderr for copy-paste fallback.
        let _ = open::that(auth_url.as_str());
    }

    let code = await_callback(&listener, &state).await?;
    let tokens = exchange_code(creds, &code, &verifier, &redirect_uri).await?;

    let refresh_token = tokens.refresh_token.ok_or_else(|| {
        CliError::new(
            "No refresh_token returned. Revoke prior access at https://myaccount.google.com/permissions and run login again.",
            ErrorCode::AuthFailed,
        )
    })?;

    Ok(AuthResult {
        refresh_token,
        access_token: tokens.access_token,
        expires_at: now_ms() + tokens.expires_in * 1000,
        scope: tokens.scope,
    })
}

/// Refresh an access token using the stored refresh token. Mirrors
/// `refreshAccessToken` in `src/auth/oauth.ts`.
pub async fn refresh_access_token(
    refresh_token: &str,
    creds: &OAuthCredentials,
) -> Result<RefreshResult, CliError> {
    let body = [
        ("client_id", creds.client_id.as_str()),
        ("client_secret", creds.client_secret.as_str()),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ];
    let client = reqwest::Client::new();
    let res = client
        .post(TOKEN_ENDPOINT)
        .form(&body)
        .send()
        .await
        .map_err(|e| CliError::new(format!("token refresh: {e}"), ErrorCode::AuthFailed))?;
    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if std::env::var("DEBUG").is_ok() {
            eprintln!("[debug] token refresh response: {text}");
        }
        return Err(CliError::new(
            format!("Token refresh failed (HTTP {status}). Run with DEBUG=1 for details."),
            ErrorCode::AuthFailed,
        ));
    }
    let tokens: TokenResponse = res.json().await.map_err(|e| {
        CliError::new(
            format!("parse refresh response: {e}"),
            ErrorCode::AuthFailed,
        )
    })?;
    Ok(RefreshResult {
        access_token: tokens.access_token,
        expires_at: now_ms() + tokens.expires_in * 1000,
    })
}

// --- internals --------------------------------------------------------------

async fn exchange_code(
    creds: &OAuthCredentials,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, CliError> {
    let body = [
        ("client_id", creds.client_id.as_str()),
        ("client_secret", creds.client_secret.as_str()),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ];
    let client = reqwest::Client::new();
    let res = client
        .post(TOKEN_ENDPOINT)
        .form(&body)
        .send()
        .await
        .map_err(|e| CliError::new(format!("token exchange: {e}"), ErrorCode::AuthFailed))?;
    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        if std::env::var("DEBUG").is_ok() {
            eprintln!("[debug] token endpoint response: {text}");
        }
        return Err(CliError::new(
            format!("Token exchange failed (HTTP {status}). Run with DEBUG=1 for details."),
            ErrorCode::AuthFailed,
        ));
    }
    res.json::<TokenResponse>()
        .await
        .map_err(|e| CliError::new(format!("parse token response: {e}"), ErrorCode::AuthFailed))
}

/// Accept a single connection on `listener`, parse the GET request, validate
/// state, write a small HTML confirmation, and return the captured `code`.
async fn await_callback(listener: &TcpListener, expected_state: &str) -> Result<String, CliError> {
    loop {
        let (mut socket, _peer) = listener
            .accept()
            .await
            .map_err(|e| CliError::new(format!("loopback accept: {e}"), ErrorCode::AuthFailed))?;

        let request = read_http_request(&mut socket).await?;

        // First line: `GET /oauth2callback?... HTTP/1.1`.
        let path = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or_default();

        // Build a parseable URL by giving it a host.
        let parsed = url::Url::parse(&format!("http://localhost{path}")).map_err(|e| {
            CliError::new(format!("parse callback url: {e}"), ErrorCode::AuthFailed)
        })?;

        if parsed.path() != "/oauth2callback" {
            write_response(&mut socket, 404, "text/plain", "not found").await;
            continue;
        }

        let mut code: Option<String> = None;
        let mut state: Option<String> = None;
        let mut error: Option<String> = None;
        for (k, v) in parsed.query_pairs() {
            match &*k {
                "code" => code = Some(v.into_owned()),
                "state" => state = Some(v.into_owned()),
                "error" => error = Some(v.into_owned()),
                _ => {}
            }
        }

        if let Some(err) = error {
            // Sanitize: keep first 64 chars, replace non-word/dash/underscore.
            let safe: String = err
                .chars()
                .take(64)
                .map(|c| {
                    if c.is_alphanumeric() || c == '_' || c == '-' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            write_response(
                &mut socket,
                400,
                "text/plain",
                &format!("Authorization failed: {err}"),
            )
            .await;
            return Err(CliError::new(
                format!("OAuth error: {safe}"),
                ErrorCode::AuthFailed,
            ));
        }

        let (Some(code), Some(state)) = (code, state) else {
            write_response(&mut socket, 400, "text/plain", "missing code or state").await;
            return Err(CliError::new(
                "missing code/state on callback",
                ErrorCode::AuthFailed,
            ));
        };

        if state != expected_state {
            write_response(&mut socket, 400, "text/plain", "state mismatch").await;
            return Err(CliError::new(
                "state mismatch — possible CSRF",
                ErrorCode::AuthFailed,
            ));
        }

        write_response(
            &mut socket,
            200,
            "text/html",
            "<html><body><h2>gdrivescope: authorization complete</h2><p>You can close this tab.</p></body></html>",
        )
        .await;
        return Ok(code);
    }
}

/// Read until end of headers (CRLF CRLF). Single buffer cap because OAuth
/// callbacks are small GETs with no body.
async fn read_http_request(socket: &mut tokio::net::TcpStream) -> Result<String, CliError> {
    let mut buf = vec![0u8; 8192];
    let mut total = 0usize;
    loop {
        if total == buf.len() {
            // Bound the read — reject anything pathologically large.
            return Err(CliError::new(
                "oversized OAuth callback request",
                ErrorCode::AuthFailed,
            ));
        }
        let n = socket
            .read(&mut buf[total..])
            .await
            .map_err(|e| CliError::new(format!("loopback read: {e}"), ErrorCode::AuthFailed))?;
        if n == 0 {
            break;
        }
        total += n;
        if buf[..total].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buf[..total]).into_owned())
}

async fn write_response(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Status",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len(),
    );
    let _ = socket.write_all(response.as_bytes()).await;
    let _ = socket.shutdown().await;
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64_url(&bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    base64_url(&hasher.finalize())
}

fn base64_url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Best-effort detection of WSL (Windows Subsystem for Linux), where there is
/// no usable browser launcher. Checks the env vars WSL injects, then the
/// kernel release string (`microsoft`).
fn is_wsl() -> bool {
    if std::env::var_os("WSL_DISTRO_NAME").is_some() || std::env::var_os("WSL_INTEROP").is_some() {
        return true;
    }
    std::fs::read_to_string("/proc/sys/kernel/osrelease")
        .map(|s| s.to_ascii_lowercase().contains("microsoft"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_known_vector() {
        // RFC 7636 Appendix B.1 example: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        // → challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            pkce_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_token_is_b64url_no_padding() {
        let t = random_token();
        // 32 bytes → 43 b64 chars without padding.
        assert_eq!(t.len(), 43);
        assert!(!t.contains('='));
        assert!(!t.contains('+'));
        assert!(!t.contains('/'));
    }

    #[tokio::test]
    async fn await_callback_validates_state_and_extracts_code() {
        // Spin up the loopback listener and send a fake OAuth redirect from
        // a client task. Confirms the parser + state check round-trip.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { await_callback(&listener, "expected").await });

        let request = "GET /oauth2callback?code=secret-code&state=expected HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
        let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        sock.write_all(request.as_bytes()).await.unwrap();
        // Drain the response so the server's write completes before we drop.
        let mut resp = Vec::new();
        let _ = sock.read_to_end(&mut resp).await;

        let code = server.await.unwrap().unwrap();
        assert_eq!(code, "secret-code");
        assert!(String::from_utf8_lossy(&resp).contains("authorization complete"));
    }

    #[tokio::test]
    async fn await_callback_rejects_state_mismatch() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { await_callback(&listener, "expected").await });

        let request = "GET /oauth2callback?code=c&state=wrong HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
        let mut sock = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        sock.write_all(request.as_bytes()).await.unwrap();
        let mut resp = Vec::new();
        let _ = sock.read_to_end(&mut resp).await;

        let err = server.await.unwrap().unwrap_err();
        assert_eq!(err.code, ErrorCode::AuthFailed);
        assert!(err.message.contains("state mismatch"));
    }
}

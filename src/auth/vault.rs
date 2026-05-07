//! OS keyring-backed credential vault. Ported from `src/auth/keychain.ts`.
//! The on-disk JSON shape (under one keyring entry) MUST stay byte-equivalent
//! with the TS version so logging in via the TS binary and continuing under
//! the Rust binary (and vice versa) keeps working — Verification §4.

use serde::{Deserialize, Serialize};

use crate::error::{CliError, ErrorCode};

const SERVICE: &str = "com.softwarestartups.gdrivescope";
const VAULT_KEY: &str = "gdrivescope.vault";

// The TS code best-effort-deletes a list of legacy keychain keys
// (`GOOGLE_OAUTH_TOKENS`, `GOOGLE_OAUTH_CLIENT_ID`,
// `GOOGLE_OAUTH_CLIENT_SECRET`) that older pre-Vault TS installs created.
// We deliberately do NOT replicate that cleanup in Rust: Bun's
// `Bun.secrets.delete` is silent on ACL mismatches, but the `keyring`
// crate's `delete_credential` triggers a macOS "allow access" prompt for
// every entry whose ACL doesn't already include this binary. Forcing the
// user through three prompts on every `logout` is worse UX than the stale
// rows. Users with legacy entries can clear them via Keychain Access.app.

/// Serialized 1:1 with TS `Vault` (see `src/auth/keychain.ts:16-19`).
/// `obtainedAt` is milliseconds since the UNIX epoch (matches `Date.now()`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub refresh_token: String,
    pub scope: String,
    pub obtained_at: i64,
    pub client_id: String,
    pub client_secret: String,
}

/// Subset projected to "what the rest of the app needs" — mirrors TS
/// `getAuth()` returning `StoredAuth`.
#[derive(Debug, Clone)]
pub struct StoredAuth {
    pub refresh_token: String,
    pub scope: String,
    pub obtained_at: i64,
}

impl From<&Vault> for StoredAuth {
    fn from(v: &Vault) -> Self {
        Self {
            refresh_token: v.refresh_token.clone(),
            scope: v.scope.clone(),
            obtained_at: v.obtained_at,
        }
    }
}

/// Vault accessor abstracted over the storage backend so tests can swap in an
/// in-memory implementation without touching the real keyring.
#[async_trait::async_trait]
pub trait VaultStore: Send + Sync {
    async fn get(&self) -> Result<Option<Vault>, CliError>;
    async fn set(&self, vault: &Vault) -> Result<(), CliError>;
    /// Returns true iff anything was actually cleared.
    async fn clear(&self) -> Result<bool, CliError>;
}

/// Default keyring-backed store. macOS Keychain via Security.framework, Linux
/// secret-service via dbus, Windows Credential Manager.
///
/// **Known limitation (macOS):** the keyring v3 crate doesn't expose ACL
/// options, so entries are created with default ACL (binary-identity-bound).
/// Each fresh `cargo build` produces a new ad-hoc identifier
/// (`Identifier=gdrivescope-<contenthash>`), so the OS prompts on first
/// access of an existing entry. Production releases pinned to one signing
/// identity won't have this issue. Cross-binary compat with the TS-created
/// entries (which used Bun's `allowUnrestrictedAccess: true`) needs a
/// follow-up that drops down to `security-framework` directly to re-set the
/// ACL — tracked for Phase 11 cutover (Verification §4).
pub struct KeyringVault;

impl KeyringVault {
    pub fn new() -> Self {
        Self
    }
}

impl Default for KeyringVault {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl VaultStore for KeyringVault {
    async fn get(&self) -> Result<Option<Vault>, CliError> {
        // Keyring crate is sync — bounce off the blocking pool to avoid
        // tying up an async worker on a (sometimes slow) DBus call.
        let result = tokio::task::spawn_blocking(|| {
            let entry = match keyring::Entry::new(SERVICE, VAULT_KEY) {
                Ok(e) => e,
                Err(_) => return Ok::<Option<String>, CliError>(None),
            };
            match entry.get_password() {
                Ok(s) => Ok(Some(s)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(CliError::new(
                    format!("keyring get: {e}"),
                    ErrorCode::AuthFailed,
                )),
            }
        })
        .await
        .map_err(|e| CliError::new(format!("blocking join: {e}"), ErrorCode::Unknown))??;

        let Some(raw) = result else {
            return Ok(None);
        };
        // Mirror the TS isVault validation: malformed JSON yields None, never
        // an error — same UX as TS's swallow-and-cache-null flow.
        Ok(serde_json::from_str::<Vault>(&raw).ok())
    }

    async fn set(&self, vault: &Vault) -> Result<(), CliError> {
        let json = serde_json::to_string(vault)
            .map_err(|e| CliError::new(format!("vault serialize: {e}"), ErrorCode::Unknown))?;
        tokio::task::spawn_blocking(move || {
            let entry = keyring::Entry::new(SERVICE, VAULT_KEY)
                .map_err(|e| CliError::new(format!("keyring entry: {e}"), ErrorCode::AuthFailed))?;
            entry
                .set_password(&json)
                .map_err(|e| CliError::new(format!("keyring set: {e}"), ErrorCode::AuthFailed))
        })
        .await
        .map_err(|e| CliError::new(format!("blocking join: {e}"), ErrorCode::Unknown))?
    }

    async fn clear(&self) -> Result<bool, CliError> {
        tokio::task::spawn_blocking(|| {
            let cleared = match keyring::Entry::new(SERVICE, VAULT_KEY) {
                Ok(entry) => delete_if_present(&entry),
                Err(_) => false,
            };
            Ok::<bool, CliError>(cleared)
        })
        .await
        .map_err(|e| CliError::new(format!("blocking join: {e}"), ErrorCode::Unknown))?
    }
}

fn delete_if_present(entry: &keyring::Entry) -> bool {
    match entry.delete_credential() {
        Ok(()) => true,
        Err(keyring::Error::NoEntry) => false,
        Err(_) => false,
    }
}

/// Trim + validate a credential as it crosses the boundary into the vault.
/// Mirrors `sanitizeCredential` in `src/auth/keychain.ts:122-130`.
pub fn sanitize_credential(raw: &str) -> Result<String, CliError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CliError::new(
            "Credential cannot be empty",
            ErrorCode::BadArg,
        ));
    }
    if trimmed.len() > 4096 {
        return Err(CliError::new(
            "Credential exceeds maximum length",
            ErrorCode::BadArg,
        ));
    }
    if has_control_chars(trimmed) {
        return Err(CliError::new(
            "Credential contains invalid control characters",
            ErrorCode::BadArg,
        ));
    }
    Ok(trimmed.to_string())
}

fn has_control_chars(s: &str) -> bool {
    s.chars().any(|c| {
        let b = c as u32;
        // Match TS regex /[\x00-\x08\x0b\x0c\x0e-\x1f]/ — every C0 control
        // except TAB (\x09), LF (\x0a), and CR (\x0d).
        (b <= 0x08) || b == 0x0b || b == 0x0c || (0x0e..=0x1f).contains(&b)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// In-memory `VaultStore` for tests — never touches the real keychain.
    #[derive(Default)]
    pub struct MemoryVault {
        inner: Mutex<Option<Vault>>,
    }

    #[async_trait::async_trait]
    impl VaultStore for MemoryVault {
        async fn get(&self) -> Result<Option<Vault>, CliError> {
            Ok(self.inner.lock().unwrap().clone())
        }
        async fn set(&self, vault: &Vault) -> Result<(), CliError> {
            *self.inner.lock().unwrap() = Some(vault.clone());
            Ok(())
        }
        async fn clear(&self) -> Result<bool, CliError> {
            let mut g = self.inner.lock().unwrap();
            let was_some = g.is_some();
            *g = None;
            Ok(was_some)
        }
    }

    fn vault() -> Vault {
        Vault {
            refresh_token: "refresh-xyz".into(),
            scope: "https://www.googleapis.com/auth/drive.readonly".into(),
            obtained_at: 1_700_000_000_000,
            client_id: "client-id".into(),
            client_secret: "client-secret".into(),
        }
    }

    #[test]
    fn vault_serializes_camelcase() {
        let json = serde_json::to_string(&vault()).unwrap();
        // Field order: serde follows declaration order, which mirrors TS.
        assert_eq!(
            json,
            r#"{"refreshToken":"refresh-xyz","scope":"https://www.googleapis.com/auth/drive.readonly","obtainedAt":1700000000000,"clientId":"client-id","clientSecret":"client-secret"}"#,
        );
    }

    #[test]
    fn vault_deserializes_from_ts_shape() {
        // Keys are camelCase in the TS-emitted JSON.
        let json =
            r#"{"refreshToken":"r","scope":"s","obtainedAt":42,"clientId":"c","clientSecret":"x"}"#;
        let v: Vault = serde_json::from_str(json).unwrap();
        assert_eq!(v.refresh_token, "r");
        assert_eq!(v.obtained_at, 42);
    }

    #[tokio::test]
    async fn memory_vault_round_trip() {
        let store = MemoryVault::default();
        assert!(store.get().await.unwrap().is_none());
        store.set(&vault()).await.unwrap();
        assert_eq!(store.get().await.unwrap(), Some(vault()));
        assert!(store.clear().await.unwrap());
        assert!(!store.clear().await.unwrap());
        assert!(store.get().await.unwrap().is_none());
    }

    #[test]
    fn sanitize_credential_trims_and_validates() {
        assert_eq!(sanitize_credential("  foo  ").unwrap(), "foo");
        assert!(sanitize_credential("").is_err());
        assert!(sanitize_credential("   ").is_err());
        // Tab/LF/CR are allowed (they pass through to trim).
        assert_eq!(sanitize_credential("foo\tbar").unwrap(), "foo\tbar");
        // BEL / SOH / DEL-like control chars are rejected.
        assert!(sanitize_credential("foo\x01bar").is_err());
        assert!(sanitize_credential("foo\x07bar").is_err());
    }

    #[test]
    fn sanitize_credential_rejects_oversize() {
        let big = "a".repeat(4097);
        assert!(sanitize_credential(&big).is_err());
    }

    #[test]
    fn stored_auth_is_subset_of_vault() {
        let v = vault();
        let s = StoredAuth::from(&v);
        assert_eq!(s.refresh_token, v.refresh_token);
        assert_eq!(s.scope, v.scope);
        assert_eq!(s.obtained_at, v.obtained_at);
    }
}

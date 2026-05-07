//! OS keyring-backed credential vault. macOS Keychain via
//! `Security.framework` (with permissive ACL so a fresh `cargo build`
//! doesn't re-prompt the user), Linux `secret-service` via dbus, Windows
//! Credential Manager.

use serde::{Deserialize, Serialize};

use crate::error::{CliError, ErrorCode};

const SERVICE: &str = "com.softwarestartups.gdrivescope";
const VAULT_KEY: &str = "gdrivescope.vault";

/// Persisted shape of the keyring entry. `obtained_at` is milliseconds
/// since the UNIX epoch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Vault {
    pub refresh_token: String,
    pub scope: String,
    pub obtained_at: i64,
    pub client_id: String,
    pub client_secret: String,
}

/// Subset of `Vault` projected to "what the rest of the app needs" —
/// the fields used outside the login path.
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
/// On macOS, the write path bypasses `keyring` and goes through
/// [`macos_unrestricted::set_unrestricted`] so the entry is created with a
/// permissive ACL (any app can read). Reads stay on `keyring` because they
/// work fine once the entry is permissive. The first write after a build
/// upgrade will silently delete a previous restrictive entry (if present)
/// so the new permissive ACL takes effect immediately.
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
        // Malformed JSON yields None rather than erroring — the user sees
        // "auth required" and re-runs `login`, instead of a parse error.
        Ok(serde_json::from_str::<Vault>(&raw).ok())
    }

    async fn set(&self, vault: &Vault) -> Result<(), CliError> {
        let json = serde_json::to_string(vault)
            .map_err(|e| CliError::new(format!("vault serialize: {e}"), ErrorCode::Unknown))?;
        tokio::task::spawn_blocking(move || set_blocking(&json))
            .await
            .map_err(|e| CliError::new(format!("blocking join: {e}"), ErrorCode::Unknown))?
    }

    async fn clear(&self) -> Result<bool, CliError> {
        tokio::task::spawn_blocking(clear_blocking)
            .await
            .map_err(|e| CliError::new(format!("blocking join: {e}"), ErrorCode::Unknown))?
    }
}

#[cfg(target_os = "macos")]
fn set_blocking(json: &str) -> Result<(), CliError> {
    macos_unrestricted::set_unrestricted(SERVICE, VAULT_KEY, json.as_bytes())
}

#[cfg(not(target_os = "macos"))]
fn set_blocking(json: &str) -> Result<(), CliError> {
    let entry = keyring::Entry::new(SERVICE, VAULT_KEY)
        .map_err(|e| CliError::new(format!("keyring entry: {e}"), ErrorCode::AuthFailed))?;
    entry
        .set_password(json)
        .map_err(|e| CliError::new(format!("keyring set: {e}"), ErrorCode::AuthFailed))
}

#[cfg(target_os = "macos")]
fn clear_blocking() -> Result<bool, CliError> {
    // SecItemDelete with our `(service, account)` query — silent for
    // permissive entries, returns Ok(false) for missing items, swallows
    // other errors (matches the cross-platform branch's contract).
    Ok(macos_unrestricted::delete(SERVICE, VAULT_KEY).unwrap_or(false))
}

#[cfg(not(target_os = "macos"))]
fn clear_blocking() -> Result<bool, CliError> {
    let cleared = match keyring::Entry::new(SERVICE, VAULT_KEY) {
        Ok(entry) => delete_if_present(&entry),
        Err(_) => false,
    };
    Ok(cleared)
}

#[cfg(not(target_os = "macos"))]
fn delete_if_present(entry: &keyring::Entry) -> bool {
    match entry.delete_credential() {
        Ok(()) => true,
        Err(keyring::Error::NoEntry) => false,
        Err(_) => false,
    }
}

/// macOS Keychain writes with permissive ACL ("any app may read"). Each
/// fresh `cargo build` produces a new ad-hoc codesign identity, so without
/// a permissive ACL the OS would prompt the user on every read of an
/// existing entry. We construct the entry with `SecAccessCreate(trustedlist
/// = NULL)` + `SecItemAdd(kSecAttrAccess=...)` because the keyring crate
/// (and security-framework v3) don't expose ACL APIs; the code links
/// `Security.framework` directly for the one missing call.
#[cfg(target_os = "macos")]
mod macos_unrestricted {
    use core_foundation::array::CFArrayRef;
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::{CFString, CFStringRef};
    use core_foundation_sys::base::OSStatus;
    use security_framework_sys::item::{
        kSecAttrAccount, kSecAttrService, kSecClass, kSecClassGenericPassword, kSecValueData,
    };
    use security_framework_sys::keychain_item::{SecItemAdd, SecItemDelete, SecItemUpdate};
    use std::ptr;

    use crate::error::{CliError, ErrorCode};

    /// `errSecDuplicateItem` — entry with this `(service, account)` already exists.
    const ERR_SEC_DUPLICATE_ITEM: OSStatus = -25299;
    /// `errSecItemNotFound` — no matching entry to delete or look up.
    const ERR_SEC_ITEM_NOT_FOUND: OSStatus = -25300;

    // security-framework-sys v2 marks its `access` module as deprecated and
    // exposes only `SecAccessGetTypeID`. The `kSecAttrAccess` constant isn't
    // exported either — it's only listed for SecAccessControl-based keys
    // (`kSecAttrAccessControl`, the data-protection-keychain variant).
    // Bind both ourselves. SecAccessCreate is documented as legacy but still
    // works on macOS 26 (Tahoe).
    #[repr(C)]
    struct OpaqueSecAccess(std::ffi::c_void);
    type SecAccessRef = *mut OpaqueSecAccess;

    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecAccessCreate(
            descriptor: CFStringRef,
            trusted_list: CFArrayRef,
            access_ref: *mut SecAccessRef,
        ) -> OSStatus;

        static kSecAttrAccess: CFStringRef;
    }

    fn build_lookup_pairs(service: &CFString, account: &CFString) -> [(CFType, CFType); 3] {
        unsafe {
            [
                (
                    CFString::wrap_under_get_rule(kSecClass).as_CFType(),
                    CFString::wrap_under_get_rule(kSecClassGenericPassword).as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kSecAttrService).as_CFType(),
                    service.as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kSecAttrAccount).as_CFType(),
                    account.as_CFType(),
                ),
            ]
        }
    }

    /// Write `password` to the macOS Keychain at (`service`, `account`) with
    /// permissive ACL — any application may read without a "Confirm Access"
    /// prompt.
    ///
    /// Existing entries are deleted first so the new permissive ACL takes
    /// effect immediately. If a previous build wrote a restrictive entry,
    /// the delete may surface a one-time "Confirm Access" prompt; from
    /// then on every read and write is silent. If the user denies the
    /// prompt, the call falls through to `SecItemUpdate` (data gets
    /// refreshed but the existing restrictive ACL is preserved — the next
    /// login attempt re-tries the upgrade).
    pub fn set_unrestricted(service: &str, account: &str, password: &[u8]) -> Result<(), CliError> {
        let svc = CFString::new(service);
        let acct = CFString::new(account);
        let data = CFData::from_buffer(password);

        // Best-effort delete of any existing restrictive entry so the new
        // permissive ACL takes effect immediately.
        let _ = delete(service, account);

        // `trusted_list = NULL` → "trust any app" per Apple's
        // SecAccessCreate documentation.
        let desc = CFString::new(&format!("{service} secret"));
        let mut access: SecAccessRef = ptr::null_mut();
        let status =
            unsafe { SecAccessCreate(desc.as_concrete_TypeRef(), ptr::null(), &mut access) };
        if status != 0 {
            return Err(CliError::new(
                format!("SecAccessCreate failed: OSStatus {status}"),
                ErrorCode::AuthFailed,
            ));
        }
        // Take ownership of the +1 retain so `Drop` releases.
        let access_cf: CFType =
            unsafe { CFType::wrap_under_create_rule(access as *const std::ffi::c_void) };

        let mut pairs = Vec::with_capacity(5);
        pairs.extend(build_lookup_pairs(&svc, &acct));
        pairs.push((
            unsafe { CFString::wrap_under_get_rule(kSecValueData) }.as_CFType(),
            data.as_CFType(),
        ));
        pairs.push((
            unsafe { CFString::wrap_under_get_rule(kSecAttrAccess) }.as_CFType(),
            access_cf,
        ));
        let dict = CFDictionary::from_CFType_pairs(&pairs);
        let status = unsafe { SecItemAdd(dict.as_concrete_TypeRef(), ptr::null_mut()) };
        if status == 0 {
            return Ok(());
        }
        if status != ERR_SEC_DUPLICATE_ITEM {
            return Err(CliError::new(
                format!("SecItemAdd failed: OSStatus {status}"),
                ErrorCode::AuthFailed,
            ));
        }

        // The delete didn't take (typically: user denied the prompt).
        // Update the value in place; the existing ACL is preserved by
        // SecItemUpdate so the user isn't stuck — they can `logout` and
        // `login` again later to retry.
        let query = CFDictionary::from_CFType_pairs(&build_lookup_pairs(&svc, &acct));
        let update = CFDictionary::from_CFType_pairs(&[(
            unsafe { CFString::wrap_under_get_rule(kSecValueData) }.as_CFType(),
            data.as_CFType(),
        )]);
        let status =
            unsafe { SecItemUpdate(query.as_concrete_TypeRef(), update.as_concrete_TypeRef()) };
        if status == 0 {
            Ok(())
        } else {
            Err(CliError::new(
                format!("SecItemUpdate failed: OSStatus {status}"),
                ErrorCode::AuthFailed,
            ))
        }
    }

    /// Delete the (`service`, `account`) entry. Returns `Ok(true)` if the
    /// entry was deleted, `Ok(false)` if no entry existed, `Err(_)` on any
    /// other failure (e.g. user-denied prompt for a restrictive ACL entry).
    pub fn delete(service: &str, account: &str) -> Result<bool, CliError> {
        let svc = CFString::new(service);
        let acct = CFString::new(account);
        let query = CFDictionary::from_CFType_pairs(&build_lookup_pairs(&svc, &acct));
        let status = unsafe { SecItemDelete(query.as_concrete_TypeRef()) };
        match status {
            0 => Ok(true),
            ERR_SEC_ITEM_NOT_FOUND => Ok(false),
            _ => Err(CliError::new(
                format!("SecItemDelete failed: OSStatus {status}"),
                ErrorCode::AuthFailed,
            )),
        }
    }
}

/// Trim + validate a credential as it crosses the boundary into the vault.
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
        // Reject every C0 control except TAB (\x09), LF (\x0a), CR (\x0d).
        (b <= 0x08) || b == 0x0b || b == 0x0c || (0x0e..=0x1f).contains(&b)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::Mutex;

    /// In-memory `VaultStore` for tests — never touches the real keychain.
    #[derive(Default)]
    pub struct MemoryVault {
        inner: Mutex<Option<Vault>>,
    }

    #[async_trait::async_trait]
    impl VaultStore for MemoryVault {
        async fn get(&self) -> Result<Option<Vault>, CliError> {
            Ok(self.inner.lock().await.clone())
        }
        async fn set(&self, vault: &Vault) -> Result<(), CliError> {
            *self.inner.lock().await = Some(vault.clone());
            Ok(())
        }
        async fn clear(&self) -> Result<bool, CliError> {
            let mut g = self.inner.lock().await;
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
    fn vault_serializes_snake_case() {
        let json = serde_json::to_string(&vault()).unwrap();
        assert_eq!(
            json,
            r#"{"refresh_token":"refresh-xyz","scope":"https://www.googleapis.com/auth/drive.readonly","obtained_at":1700000000000,"client_id":"client-id","client_secret":"client-secret"}"#,
        );
    }

    #[test]
    fn vault_round_trips_through_serde() {
        let original = vault();
        let json = serde_json::to_string(&original).unwrap();
        let parsed: Vault = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, original);
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

    /// macOS Keychain smoke test — exercises the FFI module against the real
    /// keychain under a unique service name. Marked `#[ignore]` so `cargo
    /// test` doesn't touch the user's keychain by default; run explicitly
    /// with `cargo test -- --ignored macos_unrestricted_round_trip`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "writes to the real macOS Keychain; run with --ignored"]
    fn macos_unrestricted_round_trip() {
        use super::macos_unrestricted;
        // Unique-per-run service name so concurrent test invocations on the
        // same machine don't collide.
        let svc = format!(
            "com.softwarestartups.gdrivescope.test.{}",
            std::process::id()
        );
        let acct = "vault-smoke-test";
        let secret = b"hunter2-permissive";

        // Clean slate.
        let _ = macos_unrestricted::delete(&svc, acct);

        // First write creates the entry with permissive ACL.
        macos_unrestricted::set_unrestricted(&svc, acct, secret).unwrap();

        // Second write hits the duplicate path; should still succeed (the
        // migration delete clears the previous entry).
        macos_unrestricted::set_unrestricted(&svc, acct, b"new-value").unwrap();

        // Delete reports true the first time, false the second.
        assert!(macos_unrestricted::delete(&svc, acct).unwrap());
        assert!(!macos_unrestricted::delete(&svc, acct).unwrap());
    }
}

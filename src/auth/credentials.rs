//! OAuth client credential resolver. Ported from `src/auth/credentials.ts`.
//!
//! Cascade per field (clientId, clientSecret):
//!     command-line flag → environment variable → keyring vault → interactive prompt.
//!
//! Same env var names as the TS code: `GOOGLE_OAUTH_CLIENT_ID` /
//! `GOOGLE_OAUTH_CLIENT_SECRET`.

use crate::auth::oauth::OAuthCredentials;
use crate::auth::vault::{sanitize_credential, VaultStore};
use crate::error::{CliError, ErrorCode};

#[derive(Debug, Clone, Default)]
pub struct ClientCredentialFlags {
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
}

/// Abstracted prompt so tests can plug in a deterministic source.
#[async_trait::async_trait]
pub trait Prompter: Send + Sync {
    async fn prompt(&self, label: &str) -> Result<String, CliError>;
}

pub struct HiddenPrompter;

#[async_trait::async_trait]
impl Prompter for HiddenPrompter {
    async fn prompt(&self, label: &str) -> Result<String, CliError> {
        let label = label.to_string();
        tokio::task::spawn_blocking(move || {
            rpassword::prompt_password(&label)
                .map_err(|e| CliError::new(format!("prompt: {e}"), ErrorCode::AuthFailed))
        })
        .await
        .map_err(|e| CliError::new(format!("blocking join: {e}"), ErrorCode::Unknown))?
    }
}

/// Resolve both fields. `interactive=false` means "do not prompt — error if
/// nothing else found" (used by non-login commands that just need credentials
/// for refresh).
pub async fn resolve_client_credentials(
    flags: &ClientCredentialFlags,
    interactive: bool,
    vault: &dyn VaultStore,
    prompter: &dyn Prompter,
) -> Result<OAuthCredentials, CliError> {
    let cached_vault = vault.get().await?;

    let client_id = resolve_field(
        "GOOGLE_OAUTH_CLIENT_ID",
        "Google OAuth client id: ",
        flags.client_id.as_deref(),
        cached_vault.as_ref().map(|v| v.client_id.as_str()),
        interactive,
        prompter,
    )
    .await?;

    let client_secret = resolve_field(
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "Google OAuth client secret: ",
        flags.client_secret.as_deref(),
        cached_vault.as_ref().map(|v| v.client_secret.as_str()),
        interactive,
        prompter,
    )
    .await?;

    Ok(OAuthCredentials {
        client_id,
        client_secret,
    })
}

async fn resolve_field(
    env_var: &str,
    prompt_label: &str,
    flag: Option<&str>,
    from_vault: Option<&str>,
    interactive: bool,
    prompter: &dyn Prompter,
) -> Result<String, CliError> {
    let raw: Option<String> = match (flag, std::env::var(env_var).ok(), from_vault, interactive) {
        (Some(f), _, _, _) => Some(f.to_string()),
        (None, Some(e), _, _) => Some(e),
        (None, None, Some(v), _) => Some(v.to_string()),
        (None, None, None, true) => Some(prompter.prompt(prompt_label).await?),
        (None, None, None, false) => None,
    };
    let raw = raw.ok_or_else(|| {
        CliError::new(
            "Missing OAuth client credentials. Run `gdrivescope login` to set them.",
            ErrorCode::AuthRequired,
        )
    })?;
    sanitize_credential(&raw).map_err(|e| {
        // Mirror TS: re-tag the cause to mention which field went bad.
        CliError::new(
            format!("Invalid {env_var}: {}", e.message),
            ErrorCode::AuthFailed,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::vault::Vault;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryVault(Mutex<Option<Vault>>);

    #[async_trait::async_trait]
    impl VaultStore for MemoryVault {
        async fn get(&self) -> Result<Option<Vault>, CliError> {
            Ok(self.0.lock().unwrap().clone())
        }
        async fn set(&self, v: &Vault) -> Result<(), CliError> {
            *self.0.lock().unwrap() = Some(v.clone());
            Ok(())
        }
        async fn clear(&self) -> Result<bool, CliError> {
            let mut g = self.0.lock().unwrap();
            let was = g.is_some();
            *g = None;
            Ok(was)
        }
    }

    struct StubPrompt(&'static str);
    #[async_trait::async_trait]
    impl Prompter for StubPrompt {
        async fn prompt(&self, _label: &str) -> Result<String, CliError> {
            Ok(self.0.to_string())
        }
    }

    fn vault_with(client_id: &str, client_secret: &str) -> Vault {
        Vault {
            refresh_token: "r".into(),
            scope: "s".into(),
            obtained_at: 0,
            client_id: client_id.into(),
            client_secret: client_secret.into(),
        }
    }

    /// Async-aware lock so concurrent test tasks don't race on env mutations.
    /// Tokio's Mutex guard is Send across `.await`, unlike `std::sync::Mutex`.
    async fn env_lock() -> tokio::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await
    }

    #[tokio::test]
    async fn flag_wins_over_env_and_vault() {
        let _g = env_lock().await;
        // SAFETY: `set_var` is `unsafe` from Rust 1.84+ in multi-threaded
        // contexts. Tests use `env_lock` to serialize access.
        unsafe {
            std::env::set_var("GOOGLE_OAUTH_CLIENT_ID", "from-env");
        }
        let vault = MemoryVault::default();
        vault
            .set(&vault_with("from-vault", "secret-vault"))
            .await
            .unwrap();

        let creds = resolve_client_credentials(
            &ClientCredentialFlags {
                client_id: Some("from-flag".into()),
                client_secret: Some("from-flag-secret".into()),
            },
            true,
            &vault,
            &StubPrompt("from-prompt"),
        )
        .await
        .unwrap();
        unsafe {
            std::env::remove_var("GOOGLE_OAUTH_CLIENT_ID");
        }
        assert_eq!(creds.client_id, "from-flag");
        assert_eq!(creds.client_secret, "from-flag-secret");
    }

    #[tokio::test]
    async fn env_wins_over_vault_and_prompt() {
        let _g = env_lock().await;
        unsafe {
            std::env::set_var("GOOGLE_OAUTH_CLIENT_ID", "env-id");
        }
        unsafe {
            std::env::set_var("GOOGLE_OAUTH_CLIENT_SECRET", "env-secret");
        }
        let vault = MemoryVault::default();
        vault
            .set(&vault_with("vault-id", "vault-secret"))
            .await
            .unwrap();

        let creds = resolve_client_credentials(
            &ClientCredentialFlags::default(),
            true,
            &vault,
            &StubPrompt("never"),
        )
        .await
        .unwrap();
        unsafe {
            std::env::remove_var("GOOGLE_OAUTH_CLIENT_ID");
        }
        unsafe {
            std::env::remove_var("GOOGLE_OAUTH_CLIENT_SECRET");
        }
        assert_eq!(creds.client_id, "env-id");
        assert_eq!(creds.client_secret, "env-secret");
    }

    #[tokio::test]
    async fn vault_wins_over_prompt_when_present() {
        let _g = env_lock().await;
        unsafe {
            std::env::remove_var("GOOGLE_OAUTH_CLIENT_ID");
        }
        unsafe {
            std::env::remove_var("GOOGLE_OAUTH_CLIENT_SECRET");
        }
        let vault = MemoryVault::default();
        vault
            .set(&vault_with("vault-id", "vault-secret"))
            .await
            .unwrap();

        let creds = resolve_client_credentials(
            &ClientCredentialFlags::default(),
            true,
            &vault,
            &StubPrompt("never"),
        )
        .await
        .unwrap();
        assert_eq!(creds.client_id, "vault-id");
        assert_eq!(creds.client_secret, "vault-secret");
    }

    #[tokio::test]
    async fn errors_when_nothing_available_and_non_interactive() {
        let _g = env_lock().await;
        unsafe {
            std::env::remove_var("GOOGLE_OAUTH_CLIENT_ID");
        }
        unsafe {
            std::env::remove_var("GOOGLE_OAUTH_CLIENT_SECRET");
        }
        let vault = MemoryVault::default();
        let err = resolve_client_credentials(
            &ClientCredentialFlags::default(),
            false, // non-interactive
            &vault,
            &StubPrompt("never"),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::AuthRequired);
    }
}

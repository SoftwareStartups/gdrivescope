use std::time::{SystemTime, UNIX_EPOCH};

use clap::Args;
use serde::Serialize;

use crate::auth::credentials::{resolve_client_credentials, ClientCredentialFlags, HiddenPrompter};
use crate::auth::oauth::{authorize, AuthResult};
use crate::auth::scopes::{SCOPE_FULL, SCOPE_METADATA};
use crate::auth::vault::{KeyringVault, Vault, VaultStore};
use crate::error::{CliError, ErrorCode};
use crate::formatters::emit;
use crate::models::{success, ApiResponse};

#[derive(Args, Debug, Clone)]
pub struct LoginArgs {
    #[arg(long = "client-id")]
    pub client_id: Option<String>,
    #[arg(long = "client-secret")]
    pub client_secret: Option<String>,
    /// Either a full URL or one of `drive.readonly`, `drive.metadata.readonly`.
    #[arg(long)]
    pub scope: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct LoginOk {
    scope: String,
    obtained_at: i64,
}

pub async fn execute(args: LoginArgs) -> Result<(), CliError> {
    run(args, &KeyringVault::new(), &HiddenPrompter).await
}

async fn run(
    args: LoginArgs,
    vault: &dyn VaultStore,
    prompter: &dyn crate::auth::credentials::Prompter,
) -> Result<(), CliError> {
    let scope = resolve_scope(args.scope.as_deref())?;
    let creds = resolve_client_credentials(
        &ClientCredentialFlags {
            client_id: args.client_id,
            client_secret: args.client_secret,
        },
        true,
        vault,
        prompter,
    )
    .await?;
    let auth: AuthResult = authorize(&scope, &creds).await?;

    let obtained_at = now_ms();
    let new_vault = Vault {
        refresh_token: auth.refresh_token,
        scope: auth.scope.clone(),
        obtained_at,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
    };
    vault.set(&new_vault).await?;

    let resp: ApiResponse<LoginOk> = success(LoginOk {
        scope: auth.scope,
        obtained_at,
    });
    emit(&resp, |ok| format!("Logged in. Scope: {}", ok.scope));
    Ok(())
}

fn resolve_scope(input: Option<&str>) -> Result<String, CliError> {
    let raw = input.unwrap_or("drive.readonly");
    Ok(match raw {
        "drive.readonly" => SCOPE_FULL.to_string(),
        "drive.metadata.readonly" => SCOPE_METADATA.to_string(),
        s if s.starts_with("https://") => s.to_string(),
        other => {
            return Err(CliError::new(
                format!("unknown --scope value: {other}"),
                ErrorCode::BadArg,
            ));
        }
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_aliases_resolve_to_full_uris() {
        assert_eq!(resolve_scope(None).unwrap(), SCOPE_FULL);
        assert_eq!(resolve_scope(Some("drive.readonly")).unwrap(), SCOPE_FULL);
        assert_eq!(
            resolve_scope(Some("drive.metadata.readonly")).unwrap(),
            SCOPE_METADATA,
        );
    }

    #[test]
    fn scope_passthrough_for_explicit_https_uri() {
        let custom = "https://www.googleapis.com/auth/drive";
        assert_eq!(resolve_scope(Some(custom)).unwrap(), custom);
    }

    #[test]
    fn scope_rejects_unknown_alias() {
        let err = resolve_scope(Some("nope")).unwrap_err();
        assert_eq!(err.code, ErrorCode::BadArg);
    }
}

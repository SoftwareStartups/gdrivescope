use serde::Serialize;

use crate::auth::vault::{KeyringVault, VaultStore};
use crate::error::CliError;
use crate::formatters::emit;
use crate::models::{success, ApiResponse};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogoutOk {
    cleared: bool,
}

pub async fn execute() -> Result<(), CliError> {
    run(&KeyringVault::new()).await
}

async fn run(vault: &dyn VaultStore) -> Result<(), CliError> {
    let cleared = vault.clear().await?;
    let resp: ApiResponse<LogoutOk> = success(LogoutOk { cleared });
    emit(&resp, |ok| {
        if ok.cleared {
            "Cleared stored credentials.".to_string()
        } else {
            "No stored credentials to clear.".to_string()
        }
    });
    Ok(())
}

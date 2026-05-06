use clap::Args;

use crate::error::{CliError, ErrorCode};

#[derive(Args, Debug, Clone)]
pub struct LoginArgs {
    #[arg(long = "client-id")]
    pub client_id: Option<String>,
    #[arg(long = "client-secret")]
    pub client_secret: Option<String>,
    #[arg(long)]
    pub scope: Option<String>,
}

pub async fn execute(_args: LoginArgs) -> Result<(), CliError> {
    Err(CliError::new(
        "login: not yet implemented (Phase 3)",
        ErrorCode::NotYetImplemented,
    ))
}

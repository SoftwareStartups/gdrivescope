use clap::Args;

use crate::error::{CliError, ErrorCode};

#[derive(Args, Debug, Clone)]
pub struct ShowArgs {
    /// Node ID
    pub id: Option<String>,
}

pub async fn execute(_args: ShowArgs) -> Result<(), CliError> {
    Err(CliError::new(
        "show: not yet implemented (Phase 9)",
        ErrorCode::NotYetImplemented,
    ))
}

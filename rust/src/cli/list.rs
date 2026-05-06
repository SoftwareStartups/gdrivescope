use clap::Args;

use crate::error::{CliError, ErrorCode};

#[derive(Args, Debug, Clone)]
pub struct ListArgs {
    /// Folder ID, or path-like prefix
    pub target: Option<String>,
    #[arg(short, long)]
    pub recursive: bool,
    #[arg(long)]
    pub limit: Option<usize>,
    #[arg(long = "type")]
    pub kind: Option<String>,
}

pub async fn execute(_args: ListArgs) -> Result<(), CliError> {
    Err(CliError::new(
        "list: not yet implemented (Phase 9)",
        ErrorCode::NotYetImplemented,
    ))
}

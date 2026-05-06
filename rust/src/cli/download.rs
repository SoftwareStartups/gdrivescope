use clap::Args;

use crate::error::{CliError, ErrorCode};

#[derive(Args, Debug, Clone)]
pub struct DownloadArgs {
    /// File ID
    pub id: Option<String>,
    #[arg(short, long)]
    pub output: Option<String>,
    #[arg(long)]
    pub format: Option<String>,
}

pub async fn execute(_args: DownloadArgs) -> Result<(), CliError> {
    Err(CliError::new(
        "download: not yet implemented (Phase 9)",
        ErrorCode::NotYetImplemented,
    ))
}

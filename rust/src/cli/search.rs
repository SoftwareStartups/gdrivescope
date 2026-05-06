use clap::Args;

use crate::error::{CliError, ErrorCode};

#[derive(Args, Debug, Clone)]
pub struct SearchArgs {
    /// Search query
    pub query: Option<String>,
    #[arg(long)]
    pub mode: Option<String>,
    #[arg(long)]
    pub scope: Option<String>,
    #[arg(long)]
    pub limit: Option<usize>,
    #[arg(long)]
    pub threshold: Option<f32>,
    #[arg(long)]
    pub classification: Option<String>,
    #[arg(long = "type")]
    pub kind: Option<String>,
}

pub async fn execute(_args: SearchArgs) -> Result<(), CliError> {
    Err(CliError::new(
        "search: not yet implemented (Phase 8)",
        ErrorCode::NotYetImplemented,
    ))
}

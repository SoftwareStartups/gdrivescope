use clap::Subcommand;

use crate::error::{CliError, ErrorCode};

#[derive(Subcommand, Debug, Clone)]
pub enum OllamaCmd {
    /// Configure local Ollama for gdrivescope
    Setup {
        #[arg(long)]
        host: Option<String>,
        #[arg(long = "llm-model")]
        llm_model: Option<String>,
        #[arg(long = "embedding-model")]
        embedding_model: Option<String>,
        #[arg(long = "skip-pull")]
        skip_pull: bool,
    },
}

pub async fn execute(_cmd: OllamaCmd) -> Result<(), CliError> {
    Err(CliError::new(
        "ollama: not yet implemented (Phase 6)",
        ErrorCode::NotYetImplemented,
    ))
}

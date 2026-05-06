use clap::Subcommand;

use crate::error::{CliError, ErrorCode};

#[derive(Subcommand, Debug, Clone)]
pub enum ConfigCmd {
    /// Print the workspace config
    Show,
    /// List configured root folders
    ListRoots,
    /// Persist a Drive folder as a root
    AddRoot {
        /// Drive folder ID
        id: String,
        #[arg(long)]
        label: Option<String>,
    },
    /// Remove a configured root
    RemoveRoot {
        /// Drive folder ID
        id: String,
    },
}

pub async fn execute(_cmd: ConfigCmd) -> Result<(), CliError> {
    Err(CliError::new(
        "config: not yet implemented (Phase 7)",
        ErrorCode::NotYetImplemented,
    ))
}

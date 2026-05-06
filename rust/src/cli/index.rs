use clap::Args;

use crate::error::{CliError, ErrorCode};

#[derive(Args, Debug, Clone)]
pub struct IndexArgs {
    #[arg(long)]
    pub root: Option<String>,
    #[arg(long = "add-root")]
    pub add_root: bool,
    #[arg(long)]
    pub label: Option<String>,
    #[arg(long = "metadata-only")]
    pub metadata_only: bool,
    #[arg(long)]
    pub concurrency: Option<usize>,
    #[arg(long = "concurrency-drive")]
    pub concurrency_drive: Option<usize>,
    #[arg(long = "concurrency-llm")]
    pub concurrency_llm: Option<usize>,
    #[arg(long)]
    pub resume: bool,
    #[arg(long)]
    pub prune: bool,
    #[arg(long)]
    pub provider: Option<String>,
    #[arg(long = "embedding-provider")]
    pub embedding_provider: Option<String>,
    #[arg(long = "rebuild-embeddings")]
    pub rebuild_embeddings: bool,
    #[arg(long = "max-size")]
    pub max_size: Option<u64>,
    #[arg(long = "max-pdf-pages")]
    pub max_pdf_pages: Option<u32>,
}

pub async fn execute(_args: IndexArgs) -> Result<(), CliError> {
    Err(CliError::new(
        "index: not yet implemented (Phase 7)",
        ErrorCode::NotYetImplemented,
    ))
}

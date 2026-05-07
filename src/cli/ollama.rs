use clap::Subcommand;
use serde::Serialize;

use crate::config::{load_workspace_config, save_workspace_config, OllamaConfig};
use crate::error::{CliError, ErrorCode};
use crate::formatters::emit;
use crate::llm::ollama_embedding::OllamaEmbeddingProvider;
use crate::models::{success, ApiResponse};

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

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct SetupOk {
    host: String,
    llm_model: String,
    embedding_model: String,
    embedding_dimensions: usize,
    config_path: String,
}

const DEFAULT_HOST: &str = "http://localhost:11434";
const DEFAULT_LLM_MODEL: &str = "llama3.2:3b";
const DEFAULT_EMBEDDING_MODEL: &str = "nomic-embed-text";
const DEFAULT_EMBEDDING_DIMS: usize = 768;

pub async fn execute(cmd: OllamaCmd) -> Result<(), CliError> {
    let OllamaCmd::Setup {
        host,
        llm_model,
        embedding_model,
        skip_pull,
    } = cmd;

    let host = host.unwrap_or_else(|| DEFAULT_HOST.to_string());
    let llm_model = llm_model.unwrap_or_else(|| DEFAULT_LLM_MODEL.to_string());
    let embedding_model = embedding_model.unwrap_or_else(|| DEFAULT_EMBEDDING_MODEL.to_string());

    if !skip_pull {
        // Probe the embedding endpoint to verify reachability + dimensions.
        OllamaEmbeddingProvider::probe_dimension(&host, &embedding_model, DEFAULT_EMBEDDING_DIMS)
            .await
            .map_err(|e| {
                CliError::new(
                    format!(
                        "Ollama setup probe failed for {embedding_model} at {host}: {}. \
                     Pass --skip-pull to write the config anyway.",
                        e.message,
                    ),
                    ErrorCode::OllamaPullFailed,
                )
            })?;
    }

    let mut cfg = load_workspace_config().unwrap_or_default();
    cfg.ollama = Some(OllamaConfig {
        host: Some(host.clone()),
        llm_model: Some(llm_model.clone()),
        embedding_model: Some(embedding_model.clone()),
        embedding_dimensions: Some(DEFAULT_EMBEDDING_DIMS),
    });
    let path = save_workspace_config(&cfg)?;

    let resp: ApiResponse<SetupOk> = success(SetupOk {
        host,
        llm_model,
        embedding_model,
        embedding_dimensions: DEFAULT_EMBEDDING_DIMS,
        config_path: path.display().to_string(),
    });
    emit(&resp, |d| {
        format!(
            "Ollama configured: host={} llm={} embed={} dims={} → {}",
            d.host, d.llm_model, d.embedding_model, d.embedding_dimensions, d.config_path,
        )
    });
    Ok(())
}

use clap::Args;
use serde::Serialize;

use crate::config::load_workspace_config;
use crate::error::{CliError, ErrorCode};
use crate::formatters::emit;
use crate::graph::hydrate::hydrate_graph;
use crate::graph::store::Store;
use crate::llm::resolver::{resolve_embedding_provider, ResolveEmbeddingOptions};
use crate::models::{success, ApiResponse};
use crate::search::{
    lexical_search, semantic_search, Hit, LexicalSearchOptions, SemanticSearchOptions,
};
use crate::utils::db_path;

#[derive(Args, Debug, Clone)]
pub struct SearchArgs {
    pub query: Option<String>,
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
    #[arg(long = "embedding-provider")]
    pub embedding_provider: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct SearchData {
    hits: Vec<Hit>,
}

pub async fn execute(args: SearchArgs) -> Result<(), CliError> {
    let query = args
        .query
        .ok_or_else(|| CliError::new("search: <query> is required", ErrorCode::MissingArg))?;

    let cfg = load_workspace_config().unwrap_or_default();
    let store = Store::open(&db_path()?)?;
    let graph = hydrate_graph(&store)?;

    let scope_resolved = args
        .scope
        .as_deref()
        .map(|s| crate::config::resolve_folder(&cfg, s));

    let hits = if store.get_meta("embedding_dims")?.is_some() {
        let provider = resolve_embedding_provider(ResolveEmbeddingOptions {
            flag_provider: args.embedding_provider,
            config_provider: cfg.embedding.as_ref().and_then(|c| c.provider.clone()),
            config_model: cfg.embedding.as_ref().and_then(|c| c.model.clone()),
            embedding_config: cfg.embedding.clone(),
            ollama_config: cfg.ollama.clone(),
            azure_config: cfg.azure.clone(),
        })?;

        semantic_search(SemanticSearchOptions {
            query: &query,
            provider: provider.as_ref(),
            store: &store,
            graph: &graph,
            limit: args.limit,
            threshold: args.threshold,
            scope: scope_resolved.as_deref(),
            classification: args.classification.as_deref(),
            kind: args.kind.as_deref(),
        })
        .await?
    } else {
        lexical_search(LexicalSearchOptions {
            query: &query,
            graph: &graph,
            limit: args.limit,
            threshold: args.threshold,
            scope: scope_resolved.as_deref(),
            classification: args.classification.as_deref(),
            kind: args.kind.as_deref(),
        })?
    };

    let data = SearchData { hits };
    let resp: ApiResponse<SearchData> = success(data);
    emit(&resp, |d| {
        d.hits
            .iter()
            .map(|h| format!("{:.3}\t{}\t{}", h.score, h.id, h.path))
            .collect::<Vec<_>>()
            .join("\n")
    });
    Ok(())
}

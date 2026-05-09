use clap::Args;
use serde::Serialize;

use crate::error::{CliError, ErrorCode};
use crate::formatters::emit;
use crate::llm::resolver::{resolve_embedding_provider, ResolveEmbeddingOptions};
use crate::models::{success, ApiResponse};
use crate::search::{
    lexical_search, semantic_search, Hit, LexicalSearchOptions, SemanticSearchOptions,
};

use super::CommandContext;

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
    #[arg(
        long = "type",
        help = "Case-insensitive mime-type substring (e.g. `folder`, `pdf`, `document`, `spreadsheet`, `application/vnd.google-apps.folder`)"
    )]
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

    let CommandContext {
        store,
        graph,
        config: cfg,
    } = CommandContext::open()?;

    let scope_resolved = args
        .scope
        .as_deref()
        .map(|s| crate::config::resolve_folder(&cfg, s));

    // Folders are never embedded (they have no extracted content), so a
    // `--type folder` query against the kNN index always returns nothing.
    // Force the lexical path in that case — it iterates all graph nodes
    // and applies the same substring filter, so it matches folders too.
    let force_lexical = kind_targets_folders(args.kind.as_deref());

    let hits = if !force_lexical && store.get_meta("embedding_dims")?.is_some() {
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

fn kind_targets_folders(kind: Option<&str>) -> bool {
    kind.map(|k| {
        matches!(
            k.to_lowercase().as_str(),
            "folder" | "application/vnd.google-apps.folder"
        )
    })
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::kind_targets_folders;

    #[test]
    fn folder_short_form_targets_folders() {
        assert!(kind_targets_folders(Some("folder")));
    }

    #[test]
    fn folder_match_is_case_insensitive() {
        assert!(kind_targets_folders(Some("Folder")));
        assert!(kind_targets_folders(Some("FOLDER")));
    }

    #[test]
    fn folder_full_mime_targets_folders() {
        assert!(kind_targets_folders(Some(
            "application/vnd.google-apps.folder"
        )));
        assert!(kind_targets_folders(Some(
            "Application/vnd.Google-Apps.Folder"
        )));
    }

    #[test]
    fn other_kinds_do_not_target_folders() {
        assert!(!kind_targets_folders(Some("pdf")));
        assert!(!kind_targets_folders(Some("document")));
        // `application` is a substring of the folder mime but the user
        // means "all application/* mimes" — must not force lexical.
        assert!(!kind_targets_folders(Some("application")));
    }

    #[test]
    fn none_and_empty_do_not_target_folders() {
        assert!(!kind_targets_folders(None));
        assert!(!kind_targets_folders(Some("")));
    }
}

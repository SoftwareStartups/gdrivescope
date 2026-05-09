use clap::Args;
use serde::Serialize;

use crate::error::CliError;
use crate::formatters::emit;
use crate::graph::paths::{descendants, node_path};
use crate::models::{success, ApiResponse};

use super::CommandContext;

#[derive(Args, Debug, Clone)]
pub struct ListArgs {
    /// Folder ID, or path-like alias resolved against config.toml's `[folders]`.
    pub target: Option<String>,
    #[arg(short, long)]
    pub recursive: bool,
    #[arg(long)]
    pub limit: Option<usize>,
    #[arg(long = "type")]
    pub kind: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct Entry {
    id: String,
    name: String,
    mime_type: String,
    parent_id: Option<String>,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct ListData {
    entries: Vec<Entry>,
    total: usize,
}

pub async fn execute(args: ListArgs) -> Result<(), CliError> {
    let CommandContext {
        store,
        graph,
        config,
    } = CommandContext::open()?;

    let parent_filter = args
        .target
        .as_deref()
        .map(|t| crate::config::resolve_folder(&config, t));

    let mut entries: Vec<Entry> = Vec::new();
    if args.recursive {
        let scope = parent_filter.as_deref();
        let ids: Vec<String> = match scope {
            Some(root) => descendants(&graph, root).into_iter().collect(),
            None => graph.nodes().map(|n| n.id.clone()).collect(),
        };
        for id in ids {
            if let Some(n) = graph.get(&id) {
                if matches_kind(&args.kind, &n.mime_type) {
                    entries.push(Entry {
                        id: n.id.clone(),
                        name: n.name.clone(),
                        mime_type: n.mime_type.clone(),
                        parent_id: n.parent_id.clone(),
                        path: node_path(&graph, &n.id),
                    });
                }
            }
        }
    } else {
        let nodes = store.list_children(parent_filter.as_deref())?;
        for n in nodes {
            if matches_kind(&args.kind, &n.mime_type) {
                entries.push(Entry {
                    id: n.id.clone(),
                    name: n.name.clone(),
                    mime_type: n.mime_type.clone(),
                    parent_id: n.parent_id.clone(),
                    path: node_path(&graph, &n.id),
                });
            }
        }
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    if let Some(limit) = args.limit {
        entries.truncate(limit);
    }
    let total = entries.len();
    let resp: ApiResponse<ListData> = success(ListData { entries, total });
    emit(&resp, |d| {
        d.entries
            .iter()
            .map(|e| format!("{}\t{}\t{}", e.id, e.mime_type, e.path))
            .collect::<Vec<_>>()
            .join("\n")
    });
    Ok(())
}

fn matches_kind(filter: &Option<String>, mime: &str) -> bool {
    match filter.as_deref() {
        None => true,
        Some("folder") => mime == "application/vnd.google-apps.folder",
        Some("file") => mime != "application/vnd.google-apps.folder",
        Some(other) => mime == other,
    }
}

use clap::Args;
use serde::Serialize;

use crate::auth::scopes::{ensure_scope, SCOPE_FULL, SCOPE_METADATA};
use crate::auth::vault::KeyringVault;
use crate::config::{load_workspace_config, save_workspace_config, upsert_root, ConfigRoot};
use crate::drive::ancestry::resolve_ancestry;
use crate::drive::client::DriveClient;
use crate::error::CliError;
use crate::formatters::emit;
use crate::graph::store::Store;
use crate::llm::resolver::{
    resolve_embedding_provider, resolve_llm_provider, ResolveEmbeddingOptions, ResolveLlmOptions,
};
use crate::models::{success, ApiResponse};
use crate::pipeline::{run_index_pipeline, IndexStats, RunIndexOpts};
use crate::utils::db_path;

const DEFAULT_MAX_SIZE_BYTES: u64 = 20 * 1024 * 1024;
const DEFAULT_MAX_PDF_PAGES: usize = 10;

#[derive(Args, Debug, Clone)]
pub struct IndexArgs {
    /// Start folder id or alias (default: every configured root, or `root` if none).
    #[arg(long)]
    pub scope: Option<String>,
    /// One-shot root override (bypasses config.toml).
    #[arg(long)]
    pub root: Option<String>,
    /// Persist the resolved root to config.toml.
    #[arg(long = "add-root")]
    pub add_root: bool,
    /// Skip extraction + LLM summarization + embeddings.
    #[arg(long = "metadata-only")]
    pub metadata_only: bool,
    /// Shorthand for --concurrency-drive.
    #[arg(long)]
    pub concurrency: Option<usize>,
    #[arg(long = "concurrency-drive")]
    pub concurrency_drive: Option<usize>,
    #[arg(long = "concurrency-llm")]
    pub concurrency_llm: Option<usize>,
    /// Only process nodes without a summary or with a recorded error.
    #[arg(long)]
    pub resume: bool,
    /// Delete store rows for files no longer visible in Drive (scoped).
    #[arg(long)]
    pub prune: bool,
    #[arg(long)]
    pub provider: Option<String>,
    #[arg(long = "embedding-provider")]
    pub embedding_provider: Option<String>,
    #[arg(long = "rebuild-embeddings")]
    pub rebuild_embeddings: bool,
    /// Skip files larger than this many bytes (default 20 MB).
    #[arg(long = "max-size")]
    pub max_size: Option<u64>,
    /// Slice PDFs to first N pages before extraction (default 10).
    #[arg(long = "max-pdf-pages")]
    pub max_pdf_pages: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct RunResult {
    root_id: String,
    root_label: String,
    scope_id: String,
    ancestry_path: Vec<String>,
    db_path: String,
    visited: u64,
    folders: u64,
    files: u64,
    extracted: u64,
    summarized: u64,
    embedded: u64,
    skipped: u64,
    errors: u64,
    pruned: u64,
    skipped_refs: u64,
    used_fallback: bool,
    traverse_ms: u128,
    process_ms: u128,
    embed_ms: u128,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
struct IndexData {
    runs: Vec<RunResult>,
}

pub async fn execute(args: IndexArgs) -> Result<(), CliError> {
    let cfg = load_workspace_config().unwrap_or_default();

    let max_size_bytes = resolve_max_size(args.max_size, &cfg);
    let max_pdf_pages = resolve_max_pdf_pages(args.max_pdf_pages, &cfg);

    let vault = KeyringVault::new();
    let required_scope = if args.metadata_only {
        SCOPE_METADATA
    } else {
        SCOPE_FULL
    };
    ensure_scope(&vault, required_scope).await?;
    let client = DriveClient::from_vault(&vault).await?;

    let llm = if args.metadata_only {
        None
    } else {
        Some(resolve_llm_provider(ResolveLlmOptions {
            flag_provider: args.provider.clone(),
            config_provider: cfg.llm.as_ref().and_then(|c| c.provider.clone()),
            config_model: cfg.llm.as_ref().and_then(|c| c.model.clone()),
            ollama_config: cfg.ollama.clone(),
            azure_config: cfg.azure.clone(),
        })?)
    };
    let embedding = if args.metadata_only {
        None
    } else {
        Some(resolve_embedding_provider(ResolveEmbeddingOptions {
            flag_provider: args.embedding_provider.clone(),
            config_provider: cfg.embedding.as_ref().and_then(|c| c.provider.clone()),
            config_model: cfg.embedding.as_ref().and_then(|c| c.model.clone()),
            embedding_config: cfg.embedding.clone(),
            ollama_config: cfg.ollama.clone(),
            azure_config: cfg.azure.clone(),
        })?)
    };

    let configured_roots: Vec<ConfigRoot> = if let Some(r) = &args.root {
        vec![ConfigRoot {
            id: r.clone(),
            label: None,
        }]
    } else {
        cfg.roots.clone()
    };

    let scopes: Vec<String> = if let Some(scope) = &args.scope {
        vec![crate::config::resolve_folder(&cfg, scope)]
    } else if let Some(r) = &args.root {
        vec![r.clone()]
    } else if !cfg.roots.is_empty() {
        cfg.roots.iter().map(|r| r.id.clone()).collect()
    } else {
        vec!["root".to_string()]
    };

    let mut runs: Vec<RunResult> = Vec::with_capacity(scopes.len());
    let mut cfg_for_save = cfg.clone();

    for scope_id in scopes {
        // Each scope opens its own Store handle (the pipeline takes ownership).
        let store = Store::open(&db_path()?)?;

        let ancestry = resolve_ancestry(&client, &scope_id, &configured_roots).await?;
        if ancestry.used_fallback && !configured_roots.is_empty() {
            eprintln!(
                "warn: scope {scope_id} is not under any configured root; indexing as a standalone tree. Add it with: gdrivescope config add-root <FOLDER_ID>",
            );
        }

        // Emit ancestor chain + scope itself before pipeline picks up descendants.
        for ancestor in &ancestry.chain {
            store.upsert_node(ancestor)?;
        }
        store.upsert_node(&ancestry.scope)?;

        let stats: IndexStats = run_index_pipeline(RunIndexOpts {
            store,
            client: client.clone(),
            root_id: ancestry.scope.id.clone(),
            anchor_root_id: Some(ancestry.root_id.clone()),
            scope_node: Some(ancestry.scope.clone()),
            metadata_only: args.metadata_only,
            llm: llm.clone(),
            embedding: embedding.clone(),
            rebuild_embeddings: args.rebuild_embeddings,
            max_size_bytes,
            max_pdf_pages,
            drive_concurrency: args.concurrency_drive.or(args.concurrency),
            llm_concurrency: args.concurrency_llm,
            resume: args.resume,
            prune: args.prune,
        })
        .await?;

        // +1 for the scope emitted ahead of pipeline; chain ancestors counted above.
        let visited = stats.visited + 1 + ancestry.chain.len() as u64;
        let folders = stats.folders + 1 + ancestry.chain.len() as u64;

        // Stamp last_index_run for downstream observability — open a fresh
        // Store handle since the pipeline consumed the previous one.
        let store = Store::open(&db_path()?)?;
        let now = chrono_iso8601_now();
        let _ = store.set_meta("last_index_run", &now);

        if args.add_root && !ancestry.used_fallback {
            upsert_root(
                &mut cfg_for_save,
                ConfigRoot {
                    id: ancestry.root_id.clone(),
                    label: Some(ancestry.root_label.clone()),
                },
            );
            save_workspace_config(&cfg_for_save)?;
        }

        let mut display_path: Vec<String> = vec![ancestry.root_label.clone()];
        for n in ancestry.chain.iter().skip(1) {
            display_path.push(n.name.clone());
        }
        if ancestry.chain.is_empty() {
            // No ancestors: scope IS the root
        } else {
            display_path.push(ancestry.scope.name.clone());
        }

        runs.push(RunResult {
            root_id: ancestry.root_id.clone(),
            root_label: ancestry.root_label.clone(),
            scope_id: ancestry.scope.id.clone(),
            ancestry_path: display_path,
            db_path: db_path()?.display().to_string(),
            visited,
            folders,
            files: stats.files,
            extracted: stats.extracted,
            summarized: stats.summarized,
            embedded: stats.embedded,
            skipped: stats.skipped,
            errors: stats.errors,
            pruned: stats.pruned,
            skipped_refs: stats.skipped_refs,
            used_fallback: ancestry.used_fallback,
            traverse_ms: stats.traverse_ms,
            process_ms: stats.process_ms,
            embed_ms: stats.embed_ms,
        });
    }

    let resp: ApiResponse<IndexData> = success(IndexData { runs });
    emit(&resp, render);
    Ok(())
}

fn resolve_max_size(flag: Option<u64>, cfg: &crate::config::WorkspaceConfig) -> u64 {
    if let Some(v) = flag {
        return v;
    }
    if let Ok(v) = std::env::var("GDRIVESCOPE_MAX_SIZE") {
        if let Ok(n) = v.parse::<u64>() {
            return n;
        }
    }
    cfg.extraction
        .as_ref()
        .and_then(|e| e.max_size_bytes)
        .unwrap_or(DEFAULT_MAX_SIZE_BYTES)
}

fn resolve_max_pdf_pages(flag: Option<usize>, cfg: &crate::config::WorkspaceConfig) -> usize {
    if let Some(v) = flag {
        return v;
    }
    if let Ok(v) = std::env::var("GDRIVESCOPE_MAX_PDF_PAGES") {
        if let Ok(n) = v.parse::<usize>() {
            return n;
        }
    }
    cfg.extraction
        .as_ref()
        .and_then(|e| e.max_pdf_pages)
        .unwrap_or(DEFAULT_MAX_PDF_PAGES)
}

fn render(d: &IndexData) -> String {
    if d.runs.is_empty() {
        return "No scopes indexed.".to_string();
    }
    if d.runs.len() == 1 {
        return render_run(&d.runs[0]);
    }
    d.runs
        .iter()
        .map(|r| format!("=== {} ===\n{}", r.root_label, render_run(r)))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn render_run(r: &RunResult) -> String {
    let path = r.ancestry_path.join(" / ");
    let mut lines = vec![
        format!("Indexed {} node(s) under {path}", r.visited),
        format!("  root:        {} ({})", r.root_label, r.root_id),
        format!("  folders:     {}", r.folders),
        format!("  files:       {}", r.files),
        format!("  extracted:   {}", r.extracted),
        format!("  summarized:  {}", r.summarized),
        format!("  embedded:    {}", r.embedded),
        format!("  skipped:     {}", r.skipped),
        format!("  errors:      {}", r.errors),
        format!("  pruned:      {}", r.pruned),
    ];
    let mut timing = vec![format!("traverse {}", fmt_ms(r.traverse_ms))];
    if r.process_ms > 0 {
        timing.push(format!("process {}", fmt_ms(r.process_ms)));
    }
    if r.embed_ms > 0 {
        timing.push(format!("embed {}", fmt_ms(r.embed_ms)));
    }
    lines.push(format!("  timing:      {}", timing.join(", ")));
    if r.skipped_refs > 0 {
        lines.push(format!(
            "  skipped-refs: {}  (broken shortcuts / unlistable folders)",
            r.skipped_refs,
        ));
    }
    lines.push(format!("  db:          {}", r.db_path));
    if r.used_fallback {
        lines.push("  note:        scope is not under any configured root".to_string());
    }
    lines.join("\n")
}

fn fmt_ms(ms: u128) -> String {
    if ms < 1000 {
        format!("{ms}ms")
    } else {
        format!("{:.1}s", (ms as f64) / 1000.0)
    }
}

/// ISO-8601 timestamp without pulling chrono. Format matches
/// JavaScript's `new Date().toISOString()`.
fn chrono_iso8601_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs() as i64;
    let ms = dur.subsec_millis();
    let (y, m, d, hh, mm, ss) = epoch_to_ymdhms(secs);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{ms:03}Z")
}

/// Convert a UNIX epoch second to (year, month, day, hour, minute, second)
/// in UTC. Civil-from-days algorithm by Howard Hinnant.
fn epoch_to_ymdhms(secs: i64) -> (i32, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let hh = (rem / 3600) as u32;
    let mm = ((rem % 3600) / 60) as u32;
    let ss = (rem % 60) as u32;

    let z = days + 719_468;
    let era = if z >= 0 {
        z / 146_097
    } else {
        (z - 146_096) / 146_097
    };
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = (yoe as i64 + era * 400) as i32;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d, hh, mm, ss)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_to_ymdhms_known_values() {
        // 2024-01-01T00:00:00Z = 1704067200
        let (y, m, d, hh, mm, ss) = epoch_to_ymdhms(1_704_067_200);
        assert_eq!((y, m, d, hh, mm, ss), (2024, 1, 1, 0, 0, 0));
        // 2024-06-15T12:34:56Z = 1718454896
        let (y, m, d, hh, mm, ss) = epoch_to_ymdhms(1_718_454_896);
        assert_eq!((y, m, d, hh, mm, ss), (2024, 6, 15, 12, 34, 56));
    }

    #[test]
    fn fmt_ms_rounds() {
        assert_eq!(fmt_ms(45), "45ms");
        assert_eq!(fmt_ms(1_500), "1.5s");
    }
}

//! Index pipeline. Orchestrates Drive traversal → markdown extraction →
//! LLM summarization → embedding.
//!
//! Concurrency model: rusqlite's `Connection` is `!Sync`, so process tasks
//! under tokio's multi-thread runtime can't share `&Store`. Instead, each
//! `process_one` returns a `ProcessOutcome` and the main task applies
//! results to the Store sequentially. The drive/LLM phases still run
//! concurrently, gated by their own `tokio::sync::Semaphore`s — but writes
//! to the DB happen back on the orchestrator task.

pub mod pruning;

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, Semaphore};

use crate::drive::client::DriveClient;
use crate::drive::download::{
    download_to_file, text_export_map, DownloadFormat, DownloadTargetFile,
};
use crate::drive::permanent_errors::{classify, format_marker, humanize, is_permanent_marker};
use crate::drive::traversal::{traverse_drive_folder, TraverseOptions, TraverseResult};
use crate::error::{CliError, ErrorCode};
use crate::extract::{extract_to_markdown, should_extract, ExtractOptions};
use crate::graph::hydrate::hydrate_graph;
use crate::graph::model::{DriveGraph, DriveNodeInput, Node};
use crate::graph::paths::{descendants, node_path};
use crate::graph::store::{Store, SummaryUpdate};
use crate::llm::embedding::EmbeddingProvider;
use crate::llm::provider::{LlmProvider, LlmSummarizeInput};
use crate::pipeline::pruning::{compute_prune_set, PruneSetInput};

/// Embed the first 2000 chars of each document. Most embedding models cap
/// at 8k tokens (~32k chars), but document-level similarity is dominated
/// by lead paragraphs in practice — per-chunk embeddings would multiply
/// storage cost without adding signal for our search use case.
const EMBED_WINDOW: usize = 2000;
const DEFAULT_DRIVE_CONCURRENCY: usize = 15;
const DEFAULT_LLM_CONCURRENCY: usize = 4;
const DEFAULT_OLLAMA_LLM_CONCURRENCY: usize = 1;
const TRAVERSE_UPSERT_BATCH: usize = 200;

pub struct RunIndexOpts {
    pub store: Store,
    pub client: DriveClient,
    pub root_id: String,
    pub metadata_only: bool,
    pub llm: Option<Arc<dyn LlmProvider>>,
    pub embedding: Option<Arc<dyn EmbeddingProvider>>,
    pub rebuild_embeddings: bool,
    pub max_size_bytes: u64,
    pub max_pdf_pages: usize,
    /// Anchor root id stamped on emitted nodes. Falls back to `root_id`.
    pub anchor_root_id: Option<String>,
    /// Pre-resolved scope node — skips the traversal seed `files.get`.
    pub scope_node: Option<DriveNodeInput>,
    pub drive_concurrency: Option<usize>,
    pub llm_concurrency: Option<usize>,
    pub resume: bool,
    pub prune: bool,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct IndexStats {
    pub visited: u64,
    pub folders: u64,
    pub files: u64,
    pub skipped_refs: u64,
    pub extracted: u64,
    pub summarized: u64,
    pub embedded: u64,
    pub skipped: u64,
    pub errors: u64,
    pub pruned: u64,
    pub traverse_ms: u128,
    pub process_ms: u128,
    pub embed_ms: u128,
}

impl IndexStats {
    fn merge_traverse(&mut self, t: &TraverseResult) {
        self.visited = t.visited;
        self.folders = t.folders;
        self.files = t.files;
        self.skipped_refs = t.skipped_refs;
    }
}

pub async fn run_index_pipeline(opts: RunIndexOpts) -> Result<IndexStats, CliError> {
    let mut stats = IndexStats::default();

    // ── Stage 1: traverse + upsert ──────────────────────────────────────
    let (tx, mut rx) = mpsc::channel::<DriveNodeInput>(256);
    let traverse_opts = TraverseOptions {
        root_id: opts.root_id.clone(),
        anchor_root_id: opts.anchor_root_id.clone(),
        scope_node: opts.scope_node.clone(),
        concurrency: opts.drive_concurrency,
    };
    let traverse_client = opts.client.clone();
    let traverse_handle: tokio::task::JoinHandle<Result<TraverseResult, CliError>> = tokio::spawn(
        async move { traverse_drive_folder(&traverse_client, traverse_opts, tx).await },
    );

    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut buffer: Vec<DriveNodeInput> = Vec::new();
    let traverse_start = Instant::now();
    while let Some(node) = rx.recv().await {
        seen_ids.insert(node.id.clone());
        buffer.push(node);
        if buffer.len() >= TRAVERSE_UPSERT_BATCH {
            opts.store.upsert_nodes(&buffer)?;
            buffer.clear();
        }
    }
    if !buffer.is_empty() {
        opts.store.upsert_nodes(&buffer)?;
    }
    let traverse_result = traverse_handle
        .await
        .map_err(|e| CliError::new(format!("traversal join: {e}"), ErrorCode::Unknown))??;
    stats.merge_traverse(&traverse_result);
    stats.traverse_ms = traverse_start.elapsed().as_millis();

    // ── Hydrate graph + optional prune ──────────────────────────────────
    let mut graph = hydrate_graph(&opts.store)?;

    // The hydrated graph contains every node ever indexed, across all roots.
    // Per-file work below must be restricted to the current scope subtree.
    let scope_set: HashSet<String> = {
        let mut s = descendants(&graph, &opts.root_id);
        s.insert(opts.root_id.clone());
        s
    };

    if opts.prune {
        let to_delete = compute_prune_set(PruneSetInput {
            graph: &graph,
            seen_ids: &seen_ids,
            scope_id: Some(opts.root_id.as_str()),
        });
        if !to_delete.is_empty() {
            opts.store.delete_nodes(&to_delete)?;
            stats.pruned = to_delete.len() as u64;
        }
    }

    if opts.metadata_only || opts.llm.is_none() {
        return Ok(stats);
    }

    // Probe embedding provider to fail-fast on dim mismatch before paying
    // any LLM spend.
    if let Some(emb) = &opts.embedding {
        emb.probe().await?;
    }

    let llm = opts
        .llm
        .as_ref()
        .expect("llm presence checked above")
        .clone();
    let drive_concurrency = opts.drive_concurrency.unwrap_or(DEFAULT_DRIVE_CONCURRENCY);
    let llm_concurrency = resolve_llm_concurrency(llm.as_ref(), opts.llm_concurrency);
    let drive_sem = Arc::new(Semaphore::new(drive_concurrency.max(1)));
    let llm_sem = Arc::new(Semaphore::new(llm_concurrency.max(1)));

    let workdir = tempfile::Builder::new()
        .prefix("gdrivescope-")
        .tempdir()
        .map_err(|e| CliError::new(format!("tempdir: {e}"), ErrorCode::Unknown))?;

    let work = build_work_list(&graph, &scope_set, opts.resume);
    stats.skipped += work.skipped;

    let process_start = Instant::now();

    // Compute every node's path up-front so `process_one` doesn't need
    // `&DriveGraph`. (Path computation is cheap; pre-computing also keeps
    // the spawned futures `'static`-friendly.)
    let work_with_paths: Vec<(Node, String)> = work
        .work
        .into_iter()
        .map(|n| {
            let p = node_path(&graph, &n.id);
            (n, p)
        })
        .collect();

    let mut tasks = Vec::with_capacity(work_with_paths.len());
    for (node, path) in work_with_paths {
        let drive_sem = drive_sem.clone();
        let llm_sem = llm_sem.clone();
        let client = opts.client.clone();
        let llm = llm.clone();
        let workdir_path = workdir.path().to_path_buf();
        let max_size = opts.max_size_bytes;
        let max_pdf_pages = opts.max_pdf_pages;
        tasks.push(tokio::spawn(async move {
            process_one(
                node,
                path,
                client,
                llm,
                drive_sem,
                llm_sem,
                workdir_path,
                max_size,
                max_pdf_pages,
            )
            .await
        }));
    }

    // Apply outcomes sequentially (Store is !Sync).
    for task in tasks {
        let outcome = task
            .await
            .map_err(|e| CliError::new(format!("process join: {e}"), ErrorCode::Unknown))?;
        apply_outcome(&opts.store, &mut graph, &mut stats, outcome);
    }

    stats.process_ms = process_start.elapsed().as_millis();

    // ── Stage 3: embedding ──────────────────────────────────────────────
    if let Some(embedding) = opts.embedding.as_ref() {
        opts.store
            .init_vector_table(embedding.dimensions(), opts.rebuild_embeddings)?;
        if opts.rebuild_embeddings {
            opts.store.clear_embedded_hashes()?;
            // Mirror in-memory: clear last_embedded_hash on every node.
            let ids: Vec<String> = graph.nodes().map(|n| n.id.clone()).collect();
            for id in ids {
                if let Some(n) = graph.get_mut(&id) {
                    n.last_embedded_hash = None;
                }
            }
        }
        let to_embed: Vec<&Node> = graph
            .nodes()
            .filter(|n| {
                n.extracted_md.is_some()
                    && n.content_hash.is_some()
                    && n.content_hash != n.last_embedded_hash
            })
            .collect();
        if !to_embed.is_empty() {
            let embed_start = Instant::now();
            let texts: Vec<String> = to_embed
                .iter()
                .map(|n| {
                    n.extracted_md
                        .as_ref()
                        .map(|md| md.chars().take(EMBED_WINDOW).collect::<String>())
                        .unwrap_or_default()
                })
                .collect();
            let vectors = embedding.embed(&texts).await?;
            let mut written = 0;
            for (n, vec) in to_embed.iter().zip(vectors.iter()) {
                let Some(hash) = n.content_hash.as_deref() else {
                    continue;
                };
                opts.store.upsert_embedding(&n.id, vec)?;
                opts.store.mark_embedded(&n.id, hash)?;
                written += 1;
            }
            stats.embedded = written;
            stats.embed_ms = embed_start.elapsed().as_millis();
        }
    }

    // workdir is auto-cleaned when `tempfile::TempDir` drops.
    Ok(stats)
}

fn resolve_llm_concurrency(llm: &dyn LlmProvider, explicit: Option<usize>) -> usize {
    if let Some(n) = explicit {
        if llm.name() == "ollama" && n > 1 {
            eprintln!(
                "info: index: --concurrency-llm={n} against Ollama; the local model usually serializes inference per request, so >1 mostly adds queueing latency.",
            );
        }
        return n;
    }
    if llm.name() == "ollama" {
        DEFAULT_OLLAMA_LLM_CONCURRENCY
    } else {
        DEFAULT_LLM_CONCURRENCY
    }
}

struct WorkList {
    work: Vec<Node>,
    skipped: u64,
}

fn build_work_list(graph: &DriveGraph, scope_set: &HashSet<String>, resume: bool) -> WorkList {
    let mut work = Vec::new();
    let mut skipped: u64 = 0;
    for node in graph.nodes() {
        if !scope_set.contains(&node.id) {
            continue;
        }
        if !should_extract(&node.mime_type) {
            skipped += 1;
            continue;
        }
        if resume {
            let summary_done = node.summary.is_some() && node.last_error.is_none();
            let permanent_skip = node
                .last_error
                .as_deref()
                .map(is_permanent_marker)
                .unwrap_or(false);
            if summary_done || permanent_skip {
                continue;
            }
        }
        work.push(node.clone());
    }
    WorkList { work, skipped }
}

#[derive(Debug)]
struct ProcessOutcome {
    node_id: String,
    node_name: String,
    node_mime: String,
    node_size: Option<u64>,
    result: ProcessResult,
}

#[derive(Debug)]
enum ProcessResult {
    /// Summary written; cache the in-memory node update.
    Summarized {
        markdown: String,
        hash: String,
        summary: String,
        classification: String,
        key_topics_json: String,
    },
    /// Up-to-date (content unchanged AND summary already present).
    AlreadyCached,
    /// File was too large or some skip condition hit.
    Skipped(String),
    /// Operation failed — full error message captured.
    Failed(CliError),
}

#[allow(clippy::too_many_arguments)]
async fn process_one(
    node: Node,
    path: String,
    client: DriveClient,
    llm: Arc<dyn LlmProvider>,
    drive_sem: Arc<Semaphore>,
    llm_sem: Arc<Semaphore>,
    workdir: std::path::PathBuf,
    max_size_bytes: u64,
    max_pdf_pages: usize,
) -> ProcessOutcome {
    let outcome_meta = (
        node.id.clone(),
        node.name.clone(),
        node.mime_type.clone(),
        node.size,
    );
    let make = |result: ProcessResult| ProcessOutcome {
        node_id: outcome_meta.0.clone(),
        node_name: outcome_meta.1.clone(),
        node_mime: outcome_meta.2.clone(),
        node_size: outcome_meta.3,
        result,
    };

    if let Some(size) = node.size {
        if size > max_size_bytes {
            return make(ProcessResult::Skipped(format!(
                "skipped: too large ({} bytes > {})",
                size, max_size_bytes,
            )));
        }
    }

    // ── Drive phase: download + extract + hash ──────────────────────────
    let (markdown, download_mime, hash) = {
        let _drive_permit = match drive_sem.acquire().await {
            Ok(p) => p,
            Err(e) => {
                return make(ProcessResult::Failed(CliError::new(
                    format!("drive sem: {e}"),
                    ErrorCode::Unknown,
                )))
            }
        };
        let dest = workdir.join(&node.id);
        let target = DownloadTargetFile {
            id: node.id.clone(),
            name: node.name.clone(),
            mime_type: node.mime_type.clone(),
        };
        let download = match download_to_file(
            &client,
            &target,
            &dest,
            DownloadFormat::Auto,
            &text_export_map(),
        )
        .await
        {
            Ok(d) => d,
            Err(e) => return make(ProcessResult::Failed(e)),
        };

        let raw = match tokio::fs::read(&download.output_path).await {
            Ok(b) => b,
            Err(e) => {
                return make(ProcessResult::Failed(CliError::new(
                    format!("read downloaded file: {e}"),
                    ErrorCode::Unknown,
                )));
            }
        };
        let download_mime = download.mime_type.clone();

        let markdown = if download_mime == "text/plain" || download_mime == "text/csv" {
            String::from_utf8_lossy(&raw).into_owned()
        } else {
            if (raw.len() as u64) > max_size_bytes {
                return make(ProcessResult::Skipped(format!(
                    "skipped: too large after download ({} bytes)",
                    raw.len(),
                )));
            }
            let opts = ExtractOptions {
                max_pdf_pages: (max_pdf_pages > 0).then_some(max_pdf_pages),
            };
            match extract_to_markdown(raw, &download_mime, opts).await {
                Ok(m) => m,
                Err(e) => return make(ProcessResult::Failed(e)),
            }
        };

        let mut hasher = Sha256::new();
        hasher.update(markdown.as_bytes());
        let hash = format!("{:x}", hasher.finalize());

        if node.content_hash.as_deref() == Some(&hash) && node.summary.is_some() {
            return make(ProcessResult::AlreadyCached);
        }

        (markdown, download_mime, hash)
    }; // drive permit dropped here

    // ── LLM phase: summarize ────────────────────────────────────────────
    let _llm_permit = match llm_sem.acquire().await {
        Ok(p) => p,
        Err(e) => {
            return make(ProcessResult::Failed(CliError::new(
                format!("llm sem: {e}"),
                ErrorCode::Unknown,
            )))
        }
    };
    let summary = match llm
        .summarize(&LlmSummarizeInput {
            markdown: markdown.clone(),
            filename: node.name.clone(),
            path,
            mime_type: download_mime.clone(),
        })
        .await
    {
        Ok(s) => s,
        Err(e) => return make(ProcessResult::Failed(e)),
    };
    let key_topics_json =
        serde_json::to_string(&summary.key_topics).unwrap_or_else(|_| "[]".into());

    let _ = download_mime;
    make(ProcessResult::Summarized {
        markdown,
        hash,
        summary: summary.summary,
        classification: summary.classification.as_str().to_string(),
        key_topics_json,
    })
}

fn apply_outcome(
    store: &Store,
    graph: &mut DriveGraph,
    stats: &mut IndexStats,
    outcome: ProcessOutcome,
) {
    match outcome.result {
        ProcessResult::AlreadyCached => {}
        ProcessResult::Skipped(msg) => {
            stats.errors += 1;
            let _ = store.record_error(&outcome.node_id, &msg);
        }
        ProcessResult::Failed(ref err) => {
            stats.errors += 1;
            let info = classify(err);
            let recorded = match info {
                Some(info) => format_marker(&info, &err.message),
                None => err.message.clone(),
            };
            let _ = store.record_error(&outcome.node_id, &recorded);
            let prefix = describe_node(&outcome);
            match info {
                Some(info) => {
                    eprintln!("warn: index: skipped {prefix}: {}", humanize(info.reason),)
                }
                None => eprintln!("warn: index: {prefix} failed: {}", err.message),
            }
        }
        ProcessResult::Summarized {
            markdown,
            hash,
            summary,
            classification,
            key_topics_json,
        } => {
            stats.extracted += 1;
            let patch = SummaryUpdate {
                summary: summary.clone(),
                classification: classification.clone(),
                key_topics: key_topics_json.clone(),
                extracted_md: markdown.clone(),
                content_hash: hash.clone(),
            };
            let _ = store.update_summary(&outcome.node_id, &patch);
            stats.summarized += 1;
            // Mirror in-memory so the embedding phase reads fresh state.
            if let Some(n) = graph.get_mut(&outcome.node_id) {
                n.summary = Some(summary);
                n.classification = Some(classification);
                n.key_topics = Some(key_topics_json);
                n.extracted_md = Some(markdown);
                n.content_hash = Some(hash);
                n.last_error = None;
            }
        }
    }
}

fn describe_node(o: &ProcessOutcome) -> String {
    let size = match o.node_size {
        Some(s) => format!(", {s}B"),
        None => String::new(),
    };
    format!(
        "\"{}\" ({}, {}{})",
        o.node_name, o.node_id, o.node_mime, size
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::model::Node;

    fn n(id: &str, mime: &str, summary: Option<&str>, last_error: Option<&str>) -> Node {
        Node {
            id: id.to_string(),
            parent_id: None,
            name: id.to_string(),
            mime_type: mime.to_string(),
            size: None,
            modified_time: None,
            created_time: None,
            web_view_link: None,
            root_id: None,
            metadata_json: "{}".to_string(),
            summary: summary.map(str::to_string),
            classification: None,
            key_topics: None,
            extracted_md: None,
            content_hash: None,
            last_embedded_hash: None,
            last_indexed: None,
            last_error: last_error.map(str::to_string),
        }
    }

    fn full_scope(g: &DriveGraph) -> HashSet<String> {
        g.nodes().map(|n| n.id.clone()).collect()
    }

    #[test]
    fn build_work_list_filters_out_unsupported_mimes() {
        let mut g = DriveGraph::new();
        g.add_node(n("a", "application/pdf", None, None));
        g.add_node(n("b", "image/png", None, None));
        g.add_node(n("c", "application/vnd.google-apps.folder", None, None));
        let scope = full_scope(&g);
        let wl = build_work_list(&g, &scope, false);
        assert_eq!(wl.work.len(), 1);
        assert_eq!(wl.work[0].id, "a");
        assert_eq!(wl.skipped, 2);
    }

    #[test]
    fn build_work_list_with_resume_skips_done_and_permanent() {
        let mut g = DriveGraph::new();
        g.add_node(n("done", "application/pdf", Some("S"), None));
        g.add_node(n(
            "perm",
            "application/pdf",
            None,
            Some("[permanent:forbidden] x"),
        ));
        g.add_node(n("retry", "application/pdf", None, Some("transient")));
        let scope = full_scope(&g);
        let wl = build_work_list(&g, &scope, true);
        assert_eq!(wl.work.len(), 1);
        assert_eq!(wl.work[0].id, "retry");
    }

    #[test]
    fn build_work_list_without_resume_includes_done_nodes() {
        let mut g = DriveGraph::new();
        g.add_node(n("done", "application/pdf", Some("S"), None));
        let scope = full_scope(&g);
        let wl = build_work_list(&g, &scope, false);
        assert_eq!(wl.work.len(), 1);
    }

    #[test]
    fn build_work_list_excludes_nodes_outside_scope_set() {
        // Two disjoint subtrees in the same DB. Scope only covers subtree A.
        // Subtree B nodes — even fresh ones with no summary — must be skipped.
        let mut g = DriveGraph::new();
        g.add_node(n("a-pdf", "application/pdf", None, None));
        g.add_node(n("a-doc", "application/pdf", Some("cached"), None));
        g.add_node(n("b-pdf-fresh", "application/pdf", None, None));
        g.add_node(n("b-pdf-with-summary", "application/pdf", Some("S"), None));

        let scope: HashSet<String> = ["a-pdf", "a-doc"].iter().map(|s| s.to_string()).collect();

        let wl = build_work_list(&g, &scope, false);
        let ids: HashSet<String> = wl.work.iter().map(|n| n.id.clone()).collect();
        assert_eq!(
            ids,
            ["a-pdf", "a-doc"].iter().map(|s| s.to_string()).collect(),
        );
        // Out-of-scope nodes are skipped silently — they shouldn't inflate the
        // unsupported-mime counter.
        assert_eq!(wl.skipped, 0);
    }
}

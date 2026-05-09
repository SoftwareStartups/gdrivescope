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
use crate::llm::provider::{BatchOptions, LlmProvider, LlmSummarizeInput, LlmSummary};
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
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";

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
    /// Tunables for the async Batch API path. Only consulted when the
    /// resolved LLM provider returns `supports_batch() == true`.
    pub batch_options: BatchOptions,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct IndexStats {
    pub visited: u64,
    pub folders: u64,
    pub files: u64,
    pub skipped_refs: u64,
    /// Files freshly summarized in *this* run.
    pub summarized: u64,
    /// Files that hit `AlreadyCached` (content + summary unchanged since
    /// last run). Counted once per re-run, not in `summarized`.
    pub cached: u64,
    /// Vectors written by Stage 4 in this run. May exceed `summarized`
    /// when a prior run summarised but didn't reach the embedding stage.
    pub embedded: u64,
    /// Files filtered out: non-extractable mime (e.g. images), or runtime
    /// skip such as "too large". Folders are *not* counted here.
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

    let seen_ids = stage_traverse_and_upsert(
        &opts.store,
        &opts.client,
        &opts.root_id,
        opts.anchor_root_id.as_deref(),
        opts.scope_node.clone(),
        opts.drive_concurrency,
        &mut stats,
    )
    .await?;

    let (mut graph, scope_set) = stage_hydrate_and_prune(
        &opts.store,
        &opts.root_id,
        opts.prune,
        &seen_ids,
        &mut stats,
    )?;

    let Some(llm) = opts.llm.clone() else {
        return Ok(stats);
    };
    if opts.metadata_only {
        return Ok(stats);
    }

    // Probe embedding provider to fail-fast on dim mismatch before paying
    // any LLM spend.
    if let Some(emb) = &opts.embedding {
        emb.probe().await?;
    }

    stage_process(
        &opts.store,
        &opts.client,
        llm,
        &mut graph,
        &scope_set,
        opts.max_size_bytes,
        opts.max_pdf_pages,
        opts.drive_concurrency,
        opts.llm_concurrency,
        opts.resume,
        &opts.batch_options,
        &mut stats,
    )
    .await?;

    if let Some(embedding) = opts.embedding.as_ref() {
        stage_embed(
            &opts.store,
            embedding.as_ref(),
            &mut graph,
            &scope_set,
            opts.rebuild_embeddings,
            &mut stats,
        )
        .await?;
    }

    Ok(stats)
}

async fn stage_traverse_and_upsert(
    store: &Store,
    client: &DriveClient,
    root_id: &str,
    anchor_root_id: Option<&str>,
    scope_node: Option<DriveNodeInput>,
    drive_concurrency: Option<usize>,
    stats: &mut IndexStats,
) -> Result<HashSet<String>, CliError> {
    let (tx, mut rx) = mpsc::channel::<DriveNodeInput>(256);
    let traverse_opts = TraverseOptions {
        root_id: root_id.to_string(),
        anchor_root_id: anchor_root_id.map(str::to_string),
        scope_node,
        concurrency: drive_concurrency,
    };
    let traverse_client = client.clone();
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
            store.upsert_nodes(&buffer)?;
            buffer.clear();
        }
    }
    if !buffer.is_empty() {
        store.upsert_nodes(&buffer)?;
    }
    let traverse_result = traverse_handle
        .await
        .map_err(|e| CliError::new(format!("traversal join: {e}"), ErrorCode::Unknown))??;
    stats.merge_traverse(&traverse_result);
    stats.traverse_ms = traverse_start.elapsed().as_millis();
    Ok(seen_ids)
}

fn stage_hydrate_and_prune(
    store: &Store,
    root_id: &str,
    prune: bool,
    seen_ids: &HashSet<String>,
    stats: &mut IndexStats,
) -> Result<(DriveGraph, HashSet<String>), CliError> {
    let graph = hydrate_graph(store)?;

    // The hydrated graph contains every node ever indexed, across all roots.
    // Per-file work below must be restricted to the current scope subtree.
    let scope_set: HashSet<String> = {
        let mut s = descendants(&graph, root_id);
        s.insert(root_id.to_string());
        s
    };

    if prune {
        let to_delete = compute_prune_set(PruneSetInput {
            graph: &graph,
            seen_ids,
            scope_id: Some(root_id),
        });
        if !to_delete.is_empty() {
            store.delete_nodes(&to_delete)?;
            stats.pruned = to_delete.len() as u64;
        }
    }

    Ok((graph, scope_set))
}

#[allow(clippy::too_many_arguments)]
async fn stage_process(
    store: &Store,
    client: &DriveClient,
    llm: Arc<dyn LlmProvider>,
    graph: &mut DriveGraph,
    scope_set: &HashSet<String>,
    max_size_bytes: u64,
    max_pdf_pages: usize,
    drive_concurrency: Option<usize>,
    llm_concurrency: Option<usize>,
    resume: bool,
    batch_options: &BatchOptions,
    stats: &mut IndexStats,
) -> Result<(), CliError> {
    let drive_conc = drive_concurrency.unwrap_or(DEFAULT_DRIVE_CONCURRENCY);
    let llm_conc = resolve_llm_concurrency(llm.as_ref(), llm_concurrency);
    if llm.name() == "ollama" && llm_concurrency.is_some_and(|n| n > 1) {
        eprintln!(
            "info: index: --concurrency-llm={llm_conc} against Ollama; the local model usually serializes inference per request, so >1 mostly adds queueing latency.",
        );
    }
    let drive_sem = Arc::new(Semaphore::new(drive_conc.max(1)));
    let llm_sem = Arc::new(Semaphore::new(llm_conc.max(1)));

    let workdir = tempfile::Builder::new()
        .prefix("gdrivescope-")
        .tempdir()
        .map_err(|e| CliError::new(format!("tempdir: {e}"), ErrorCode::Unknown))?;

    let work = build_work_list(graph, scope_set, resume);
    stats.skipped += work.skipped;
    stats.cached += work.cached;

    let process_start = Instant::now();

    // Compute every node's path up-front so `process_one` doesn't need
    // `&DriveGraph`. (Path computation is cheap; pre-computing also keeps
    // the spawned futures `'static`-friendly.)
    let work_with_paths: Vec<(Node, String)> = work
        .work
        .into_iter()
        .map(|n| {
            let p = node_path(graph, &n.id);
            (n, p)
        })
        .collect();

    if llm.supports_batch() {
        run_batch_summarization(
            work_with_paths,
            client.clone(),
            llm,
            drive_sem,
            workdir.path().to_path_buf(),
            max_size_bytes,
            max_pdf_pages,
            batch_options,
            store,
            graph,
            stats,
        )
        .await?;
    } else {
        let mut tasks = Vec::with_capacity(work_with_paths.len());
        for (node, path) in work_with_paths {
            let drive_sem = drive_sem.clone();
            let llm_sem = llm_sem.clone();
            let client = client.clone();
            let llm = llm.clone();
            let workdir_path = workdir.path().to_path_buf();
            tasks.push(tokio::spawn(async move {
                process_one(
                    node,
                    path,
                    client,
                    llm,
                    drive_sem,
                    llm_sem,
                    workdir_path,
                    max_size_bytes,
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
            apply_outcome(store, graph, stats, outcome)?;
        }
    }

    stats.process_ms = process_start.elapsed().as_millis();
    // workdir is auto-cleaned when `tempfile::TempDir` drops.
    Ok(())
}

async fn stage_embed(
    store: &Store,
    embedding: &dyn EmbeddingProvider,
    graph: &mut DriveGraph,
    scope_set: &HashSet<String>,
    rebuild_embeddings: bool,
    stats: &mut IndexStats,
) -> Result<(), CliError> {
    store.init_vector_table(embedding.dimensions(), rebuild_embeddings)?;
    if rebuild_embeddings {
        let scope_ids: Vec<String> = scope_set.iter().cloned().collect();
        store.clear_embedded_hashes_for_ids(&scope_ids)?;
        // Mirror in-memory for the same scope so the embed-loop sees fresh state.
        for id in &scope_ids {
            if let Some(n) = graph.get_mut(id) {
                n.last_embedded_hash = None;
            }
        }
    }
    let to_embed: Vec<&Node> = graph
        .nodes()
        .filter(|n| {
            scope_set.contains(&n.id)
                && n.extracted_md.is_some()
                && n.content_hash.is_some()
                && n.content_hash != n.last_embedded_hash
        })
        .collect();
    if to_embed.is_empty() {
        return Ok(());
    }
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
        store.upsert_embedding(&n.id, vec)?;
        store.mark_embedded(&n.id, hash)?;
        written += 1;
    }
    stats.embedded = written;
    stats.embed_ms = embed_start.elapsed().as_millis();
    Ok(())
}

fn resolve_llm_concurrency(llm: &dyn LlmProvider, explicit: Option<usize>) -> usize {
    if let Some(n) = explicit {
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
    /// Nodes short-circuited because the freshly-traversed `modified_time`
    /// matches the `summary_modified_time` recorded at the last summary —
    /// no download or extract needed. Folded into `IndexStats.cached`.
    cached: u64,
}

fn build_work_list(graph: &DriveGraph, scope_set: &HashSet<String>, resume: bool) -> WorkList {
    let mut work = Vec::new();
    let mut skipped: u64 = 0;
    let mut cached: u64 = 0;
    for node in graph.nodes() {
        if !scope_set.contains(&node.id) {
            continue;
        }
        // Folders are not user-visible "skipped files" — they aren't
        // candidates for extraction. Don't inflate the counter with them.
        if node.mime_type == FOLDER_MIME {
            continue;
        }
        if !should_extract(&node.mime_type) {
            skipped += 1;
            continue;
        }
        // modifiedTime short-circuit: if Drive's freshly-fetched
        // modifiedTime matches what it was when we wrote the summary, the
        // file's content hasn't changed and we can skip download+extract
        // entirely. The post-download content_hash check in
        // fetch_and_extract remains as a safety net for cases where Drive
        // bumps modifiedTime without a content change (move, owner edit).
        if let (Some(stored), Some(_), Some(fresh)) = (
            node.summary_modified_time.as_deref(),
            node.summary.as_deref(),
            node.modified_time.as_deref(),
        ) {
            if stored == fresh {
                cached += 1;
                continue;
            }
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
    WorkList {
        work,
        skipped,
        cached,
    }
}

#[derive(Debug)]
struct ProcessOutcome {
    node_id: String,
    node_name: String,
    node_mime: String,
    node_size: Option<u64>,
    /// `modified_time` as seen on this run's traversal — captured here so
    /// `apply_outcome` can persist it as the new `summary_modified_time`
    /// when we successfully (re)summarise the file.
    node_modified_time: Option<String>,
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

/// Output of the download+extract phase, decoupled from LLM summarization.
/// Used by both the sync per-file path and the batch path.
enum FetchOutcome {
    /// Ready for summarization — markdown extracted, content hash unique.
    Ready {
        markdown: String,
        hash: String,
        download_mime: String,
    },
    AlreadyCached,
    Skipped(String),
    Failed(CliError),
}

#[allow(clippy::too_many_arguments)]
async fn fetch_and_extract(
    node: &Node,
    client: &DriveClient,
    drive_sem: Arc<Semaphore>,
    workdir: std::path::PathBuf,
    max_size_bytes: u64,
    max_pdf_pages: usize,
) -> FetchOutcome {
    if let Some(size) = node.size {
        if size > max_size_bytes {
            return FetchOutcome::Skipped(format!(
                "skipped: too large ({} bytes > {})",
                size, max_size_bytes,
            ));
        }
    }

    let _drive_permit = match drive_sem.acquire().await {
        Ok(p) => p,
        Err(e) => {
            return FetchOutcome::Failed(CliError::new(
                format!("drive sem: {e}"),
                ErrorCode::Unknown,
            ))
        }
    };
    let dest = workdir.join(&node.id);
    let target = DownloadTargetFile {
        id: node.id.clone(),
        name: node.name.clone(),
        mime_type: node.mime_type.clone(),
    };
    let download = match download_to_file(
        client,
        &target,
        &dest,
        DownloadFormat::Auto,
        &text_export_map(),
    )
    .await
    {
        Ok(d) => d,
        Err(e) => return FetchOutcome::Failed(e),
    };

    let raw = match tokio::fs::read(&download.output_path).await {
        Ok(b) => b,
        Err(e) => {
            // Best-effort cleanup of the downloaded file even on read
            // failure. The TempDir guard is the safety net; this just
            // shortens its lifetime.
            let _ = tokio::fs::remove_file(&download.output_path).await;
            return FetchOutcome::Failed(CliError::new(
                format!("read downloaded file: {e}"),
                ErrorCode::IoFailed,
            ));
        }
    };
    // Bytes are now in memory and the file on disk is no longer needed.
    // Removing per-file keeps the TempDir small over long runs and avoids
    // building up MB of PDFs in /tmp until pipeline end.
    let _ = tokio::fs::remove_file(&download.output_path).await;
    let download_mime = download.mime_type.clone();

    let markdown = if download_mime == "text/plain" || download_mime == "text/csv" {
        String::from_utf8_lossy(&raw).into_owned()
    } else {
        if (raw.len() as u64) > max_size_bytes {
            return FetchOutcome::Skipped(format!(
                "skipped: too large after download ({} bytes)",
                raw.len(),
            ));
        }
        let opts = ExtractOptions {
            max_pdf_pages: (max_pdf_pages > 0).then_some(max_pdf_pages),
        };
        match extract_to_markdown(raw, &download_mime, opts).await {
            Ok(m) => m,
            Err(e) => return FetchOutcome::Failed(e),
        }
    };

    let mut hasher = Sha256::new();
    hasher.update(markdown.as_bytes());
    let hash = format!("{:x}", hasher.finalize());

    if node.content_hash.as_deref() == Some(&hash) && node.summary.is_some() {
        return FetchOutcome::AlreadyCached;
    }

    FetchOutcome::Ready {
        markdown,
        hash,
        download_mime,
    }
}

fn make_outcome(node: &Node, result: ProcessResult) -> ProcessOutcome {
    ProcessOutcome {
        node_id: node.id.clone(),
        node_name: node.name.clone(),
        node_mime: node.mime_type.clone(),
        node_size: node.size,
        node_modified_time: node.modified_time.clone(),
        result,
    }
}

fn summarized_from(markdown: String, hash: String, summary: LlmSummary) -> ProcessResult {
    let key_topics_json =
        serde_json::to_string(&summary.key_topics).unwrap_or_else(|_| "[]".into());
    ProcessResult::Summarized {
        markdown,
        hash,
        summary: summary.summary,
        classification: summary.classification.as_str().to_string(),
        key_topics_json,
    }
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
    let fetched = fetch_and_extract(
        &node,
        &client,
        drive_sem,
        workdir,
        max_size_bytes,
        max_pdf_pages,
    )
    .await;
    let (markdown, hash, download_mime) = match fetched {
        FetchOutcome::Ready {
            markdown,
            hash,
            download_mime,
        } => (markdown, hash, download_mime),
        FetchOutcome::AlreadyCached => return make_outcome(&node, ProcessResult::AlreadyCached),
        FetchOutcome::Skipped(s) => return make_outcome(&node, ProcessResult::Skipped(s)),
        FetchOutcome::Failed(e) => return make_outcome(&node, ProcessResult::Failed(e)),
    };

    // ── LLM phase: summarize ────────────────────────────────────────────
    let _llm_permit = match llm_sem.acquire().await {
        Ok(p) => p,
        Err(e) => {
            return make_outcome(
                &node,
                ProcessResult::Failed(CliError::new(format!("llm sem: {e}"), ErrorCode::Unknown)),
            )
        }
    };
    let summary = match llm
        .summarize(&LlmSummarizeInput {
            markdown: markdown.clone(),
            filename: node.name.clone(),
            path,
            mime_type: download_mime,
        })
        .await
    {
        Ok(s) => s,
        Err(e) => return make_outcome(&node, ProcessResult::Failed(e)),
    };
    make_outcome(&node, summarized_from(markdown, hash, summary))
}

/// Batch path: download + extract every node concurrently, then ship all
/// `Ready` inputs as a single provider-side batch (50% token discount on
/// Anthropic / OpenAI / Azure). Stitches per-item batch results back into
/// the original order before applying outcomes.
#[allow(clippy::too_many_arguments)]
async fn run_batch_summarization(
    work_with_paths: Vec<(Node, String)>,
    client: DriveClient,
    llm: Arc<dyn LlmProvider>,
    drive_sem: Arc<Semaphore>,
    workdir_path: std::path::PathBuf,
    max_size_bytes: u64,
    max_pdf_pages: usize,
    batch_options: &BatchOptions,
    store: &Store,
    graph: &mut DriveGraph,
    stats: &mut IndexStats,
) -> Result<(), CliError> {
    // Phase A: fetch + extract every file concurrently (drive_sem only).
    let mut fetch_tasks = Vec::with_capacity(work_with_paths.len());
    for (node, path) in work_with_paths {
        let client = client.clone();
        let drive_sem = drive_sem.clone();
        let workdir = workdir_path.clone();
        fetch_tasks.push(tokio::spawn(async move {
            let outcome = fetch_and_extract(
                &node,
                &client,
                drive_sem,
                workdir,
                max_size_bytes,
                max_pdf_pages,
            )
            .await;
            (node, path, outcome)
        }));
    }
    let mut fetched: Vec<(Node, String, FetchOutcome)> = Vec::with_capacity(fetch_tasks.len());
    for task in fetch_tasks {
        let triple = task
            .await
            .map_err(|e| CliError::new(format!("fetch join: {e}"), ErrorCode::Unknown))?;
        fetched.push(triple);
    }

    // Phase B: collect Ready inputs and remember which fetched-index each
    // batch slot maps back to.
    let mut ready_indices: Vec<usize> = Vec::new();
    let mut ready_inputs: Vec<LlmSummarizeInput> = Vec::new();
    for (i, (node, path, outcome)) in fetched.iter().enumerate() {
        if let FetchOutcome::Ready {
            markdown,
            download_mime,
            ..
        } = outcome
        {
            ready_indices.push(i);
            ready_inputs.push(LlmSummarizeInput {
                markdown: markdown.clone(),
                filename: node.name.clone(),
                path: path.clone(),
                mime_type: download_mime.clone(),
            });
        }
    }

    // Phase C: single batch call (or skip if there's nothing new).
    let mut batch_results: Vec<Result<LlmSummary, CliError>> = if ready_inputs.is_empty() {
        Vec::new()
    } else {
        eprintln!(
            "info: index: submitting {} summary request(s) as a single {} batch (waits up to {}s)",
            ready_inputs.len(),
            llm.name(),
            batch_options.timeout.as_secs(),
        );
        llm.summarize_batch(&ready_inputs, batch_options).await?
    };
    if batch_results.len() != ready_inputs.len() {
        return Err(CliError::new(
            format!(
                "{} batch returned {} results for {} inputs",
                llm.name(),
                batch_results.len(),
                ready_inputs.len(),
            ),
            ErrorCode::LlmBatchPollFailed,
        ));
    }

    // Phase D: stitch per-item results back into fetched order, then
    // serialize through `apply_outcome` (Store is !Sync — writes happen
    // sequentially on the orchestrator task).
    let mut summary_by_idx: std::collections::HashMap<usize, Result<LlmSummary, CliError>> =
        std::collections::HashMap::with_capacity(ready_indices.len());
    for (idx, result) in ready_indices.into_iter().zip(batch_results.drain(..)) {
        summary_by_idx.insert(idx, result);
    }

    for (i, (node, _path, outcome)) in fetched.into_iter().enumerate() {
        let result = match outcome {
            FetchOutcome::AlreadyCached => ProcessResult::AlreadyCached,
            FetchOutcome::Skipped(s) => ProcessResult::Skipped(s),
            FetchOutcome::Failed(e) => ProcessResult::Failed(e),
            FetchOutcome::Ready { markdown, hash, .. } => match summary_by_idx.remove(&i) {
                Some(Ok(summary)) => summarized_from(markdown, hash, summary),
                Some(Err(e)) => ProcessResult::Failed(e),
                None => ProcessResult::Failed(CliError::new(
                    "missing batch result for input",
                    ErrorCode::LlmBatchPollFailed,
                )),
            },
        };
        let outcome = make_outcome(&node, result);
        apply_outcome(store, graph, stats, outcome)?;
    }

    Ok(())
}

fn apply_outcome(
    store: &Store,
    graph: &mut DriveGraph,
    stats: &mut IndexStats,
    outcome: ProcessOutcome,
) -> Result<(), CliError> {
    match outcome.result {
        ProcessResult::AlreadyCached => {
            stats.cached += 1;
        }
        ProcessResult::Skipped(msg) => {
            // Runtime skip (e.g. "too large") — not a hard error, but we
            // still record the reason so `gdrivescope show` surfaces it.
            stats.skipped += 1;
            store.record_error(&outcome.node_id, &msg)?;
        }
        ProcessResult::Failed(ref err) => {
            stats.errors += 1;
            let info = classify(err);
            let recorded = match info {
                Some(info) => format_marker(&info, &err.message),
                None => err.message.clone(),
            };
            store.record_error(&outcome.node_id, &recorded)?;
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
            let patch = SummaryUpdate {
                summary: summary.clone(),
                classification: classification.clone(),
                key_topics: key_topics_json.clone(),
                extracted_md: markdown.clone(),
                content_hash: hash.clone(),
                summary_modified_time: outcome.node_modified_time.clone(),
            };
            store.update_summary(&outcome.node_id, &patch)?;
            stats.summarized += 1;
            // Mirror in-memory so the embedding phase reads fresh state.
            if let Some(n) = graph.get_mut(&outcome.node_id) {
                n.summary = Some(summary);
                n.classification = Some(classification);
                n.key_topics = Some(key_topics_json);
                n.extracted_md = Some(markdown);
                n.content_hash = Some(hash);
                n.last_error = None;
                n.summary_modified_time = outcome.node_modified_time;
            }
        }
    }
    Ok(())
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
            summary_modified_time: None,
        }
    }

    /// Variant that lets tests set the traversal-fresh `modified_time` and
    /// the previously-stored `summary_modified_time` independently. Used by
    /// the cache-shortcut suite below.
    fn n_with_mtimes(
        id: &str,
        mime: &str,
        summary: Option<&str>,
        modified_time: Option<&str>,
        summary_modified_time: Option<&str>,
    ) -> Node {
        let mut node = n(id, mime, summary, None);
        node.modified_time = modified_time.map(str::to_string);
        node.summary_modified_time = summary_modified_time.map(str::to_string);
        node
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
        // Only the PNG counts as skipped; folders aren't user-visible files
        // and don't inflate the counter.
        assert_eq!(wl.skipped, 1);
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
    fn build_work_list_short_circuits_when_modtime_matches() {
        let mut g = DriveGraph::new();
        g.add_node(n_with_mtimes(
            "cached",
            "application/pdf",
            Some("S"),
            Some("2026-01-01T00:00:00.000Z"),
            Some("2026-01-01T00:00:00.000Z"),
        ));
        let scope = full_scope(&g);
        let wl = build_work_list(&g, &scope, false);
        assert!(wl.work.is_empty(), "match should suppress work");
        assert_eq!(wl.cached, 1);
        assert_eq!(wl.skipped, 0);
    }

    #[test]
    fn build_work_list_processes_when_modtime_drifts() {
        let mut g = DriveGraph::new();
        g.add_node(n_with_mtimes(
            "drifted",
            "application/pdf",
            Some("S"),
            Some("2026-02-01T00:00:00.000Z"), // freshly traversed
            Some("2026-01-01T00:00:00.000Z"), // last summary's mtime
        ));
        let scope = full_scope(&g);
        let wl = build_work_list(&g, &scope, false);
        assert_eq!(wl.work.len(), 1);
        assert_eq!(wl.work[0].id, "drifted");
        assert_eq!(wl.cached, 0);
    }

    #[test]
    fn build_work_list_processes_when_no_summary_modified_time() {
        // Pre-migration row: summary present but no summary_modified_time.
        // Must fall through to the normal flow so the next run captures it.
        let mut g = DriveGraph::new();
        g.add_node(n_with_mtimes(
            "legacy",
            "application/pdf",
            Some("S"),
            Some("2026-01-01T00:00:00.000Z"),
            None,
        ));
        let scope = full_scope(&g);
        let wl = build_work_list(&g, &scope, false);
        assert_eq!(wl.work.len(), 1);
        assert_eq!(wl.work[0].id, "legacy");
        assert_eq!(wl.cached, 0);
    }

    #[test]
    fn build_work_list_short_circuit_supersedes_resume_filter() {
        // With --resume, an already-summarised node is normally filtered;
        // the cache short-circuit fires first and counts it as cached.
        let mut g = DriveGraph::new();
        g.add_node(n_with_mtimes(
            "cached",
            "application/pdf",
            Some("S"),
            Some("2026-01-01T00:00:00.000Z"),
            Some("2026-01-01T00:00:00.000Z"),
        ));
        let scope = full_scope(&g);
        let wl = build_work_list(&g, &scope, true);
        assert!(wl.work.is_empty());
        assert_eq!(wl.cached, 1);
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

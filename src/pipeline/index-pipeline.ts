import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { drive_v3 } from '@googleapis/drive';
import { downloadToFile, TEXT_EXPORT_MIME_MAP } from '../drive/download.js';
import {
  classifyDriveError,
  formatPermanentError,
  humanizePermanentReason,
  isPermanentErrorMessage,
} from '../drive/permanent-errors.js';
import {
  type TraverseResult,
  traverseDriveFolder,
} from '../drive/traversal.js';
import { extractToMarkdown } from '../extract/kreuzberg.js';
import { shouldExtract } from '../extract/mime-filter.js';
import { slicePdfToFirstPages } from '../extract/pdf-slice.js';
import { hydrateGraph } from '../graph/hydrate.js';
import type { DriveGraph, DriveNodeInput, Node } from '../graph/model.js';
import { nodePath } from '../graph/paths.js';
import type { Store } from '../graph/store.js';
import type { EmbeddingProvider } from '../llm/embedding-provider.js';
import type { LlmProvider } from '../llm/provider.js';
import { info, warn } from '../utils/logging.js';
import { createSemaphore } from './concurrency.js';
import { computePruneSet } from './pruning.js';

// Whole-doc markdown often overruns a model's context window; embed the
// first EMBED_WINDOW characters (~500 tokens) at the document level. Per-
// chunk embeddings are deliberately deferred — `file search` ranks by
// document-level similarity, not passage-level.
const EMBED_WINDOW = 2000;
const DEFAULT_DRIVE_CONCURRENCY = 15;
const DEFAULT_LLM_CONCURRENCY = 4;
const DEFAULT_OLLAMA_LLM_CONCURRENCY = 1;
const TRAVERSE_UPSERT_BATCH = 200;

export interface RunIndexOpts {
  store: Store;
  client: drive_v3.Drive;
  rootId: string;
  metadataOnly: boolean;
  llm: LlmProvider | null;
  embedding?: EmbeddingProvider | null;
  rebuildEmbeddings?: boolean;
  maxSizeBytes: number;
  maxPdfPages: number;
  /** Anchor root id stamped on emitted nodes. Falls back to `rootId`. */
  anchorRootId?: string;
  /** Pre-resolved scope node — skips the traversal seed `files.get` call. */
  scopeNode?: DriveNodeInput;
  /** Shorthand for `driveConcurrency` — kept for backward compat. */
  concurrency?: number;
  driveConcurrency?: number;
  llmConcurrency?: number;
  resume?: boolean;
  prune?: boolean;
}

export interface IndexStats extends TraverseResult {
  extracted: number;
  summarized: number;
  embedded: number;
  skipped: number;
  errors: number;
  pruned: number;
  traverseMs: number;
  processMs: number;
  embedMs: number;
}

export async function runIndexPipeline(
  opts: RunIndexOpts
): Promise<IndexStats> {
  const seenIds = new Set<string>();
  const traverseBuffer: DriveNodeInput[] = [];
  const flushBuffer = (): void => {
    if (traverseBuffer.length === 0) return;
    opts.store.upsertNodes(traverseBuffer);
    traverseBuffer.length = 0;
  };

  const traverseStart = performance.now();
  const traverseStats = await traverseDriveFolder(opts.client, {
    rootId: opts.rootId,
    anchorRootId: opts.anchorRootId,
    scopeNode: opts.scopeNode,
    concurrency: opts.driveConcurrency ?? opts.concurrency,
    onNode: (n) => {
      seenIds.add(n.id);
      traverseBuffer.push(n);
      if (traverseBuffer.length >= TRAVERSE_UPSERT_BATCH) flushBuffer();
    },
  });
  flushBuffer();
  const traverseMs = performance.now() - traverseStart;

  const stats: IndexStats = {
    ...traverseStats,
    extracted: 0,
    summarized: 0,
    embedded: 0,
    skipped: 0,
    errors: 0,
    pruned: 0,
    traverseMs,
    processMs: 0,
    embedMs: 0,
  };

  const graph = hydrateGraph(opts.store);

  if (opts.prune) {
    const toDelete = computePruneSet({
      graph,
      seenIds,
      scopeId: opts.rootId,
    });
    if (toDelete.length > 0) {
      opts.store.deleteNodes(toDelete);
      stats.pruned = toDelete.length;
    }
  }

  if (opts.metadataOnly || !opts.llm) return stats;

  // Probe the embedding provider up-front so a mis-configured dimension
  // or model fails before any summary spend is paid on the LLM.
  if (opts.embedding?.probe) {
    await opts.embedding.probe();
  }

  const llm = opts.llm;
  const driveConcurrency =
    opts.driveConcurrency ?? opts.concurrency ?? DEFAULT_DRIVE_CONCURRENCY;
  const llmConcurrency = resolveLlmConcurrency(llm, opts.llmConcurrency);
  const driveSem = createSemaphore(Math.max(1, driveConcurrency));
  const llmSem = createSemaphore(Math.max(1, llmConcurrency));

  const workDir = mkdtempSync(join(tmpdir(), 'gdrivescope-'));
  try {
    const { work, skipped } = buildWorkList(graph, opts.resume);
    stats.skipped += skipped;

    const processStart = performance.now();
    await Promise.all(
      work.map((node) =>
        processOne({
          node,
          graph,
          llm,
          opts,
          stats,
          workDir,
          driveSem,
          llmSem,
        })
      )
    );
    stats.processMs = performance.now() - processStart;

    if (opts.embedding) {
      try {
        const embedding = opts.embedding;
        opts.store.initVectorTable(embedding.dimensions, {
          rebuild: opts.rebuildEmbeddings,
        });
        if (opts.rebuildEmbeddings) {
          // Vec0 table was dropped — every existing last_embedded_hash is
          // now a lie. Reset so the filter below re-embeds everything once.
          opts.store.clearEmbeddedHashes();
          for (const id of graph.nodes()) {
            graph.getNodeAttributes(id).lastEmbeddedHash = null;
          }
        }
        // Iterate the full (already hydrated) graph — content_hash may have
        // changed out-of-band on any node, not just those in `work`.
        const toEmbed: Array<
          Node & { extractedMd: string; contentHash: string }
        > = [];
        for (const id of graph.nodes()) {
          const n = graph.getNodeAttributes(id);
          if (
            n.extractedMd != null &&
            n.contentHash != null &&
            n.contentHash !== n.lastEmbeddedHash
          ) {
            toEmbed.push(
              n as Node & { extractedMd: string; contentHash: string }
            );
          }
        }
        if (toEmbed.length > 0) {
          const embedStart = performance.now();
          const texts = toEmbed.map((n) =>
            n.extractedMd.slice(0, EMBED_WINDOW)
          );
          const vectors = await embedding.embed(texts);
          let written = 0;
          for (let i = 0; i < toEmbed.length; i += 1) {
            const node = toEmbed[i];
            const vec = vectors[i];
            if (!node || !vec) continue;
            opts.store.upsertEmbedding(node.id, new Float32Array(vec));
            opts.store.markEmbedded(node.id, node.contentHash);
            written += 1;
          }
          stats.embedded = written;
          stats.embedMs = performance.now() - embedStart;
        }
      } catch (err) {
        stats.errors += 1;
        const message = err instanceof Error ? err.message : String(err);
        warn(`index: embedding step failed: ${message}`);
        throw err;
      }
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return stats;
}

function resolveLlmConcurrency(
  llm: LlmProvider,
  explicit: number | undefined
): number {
  if (explicit !== undefined) {
    if (llm.name === 'ollama' && explicit > 1) {
      info(
        `index: --concurrency-llm=${explicit} against Ollama; the local model usually serializes inference per request, so >1 mostly adds queueing latency.`
      );
    }
    return explicit;
  }
  return llm.name === 'ollama'
    ? DEFAULT_OLLAMA_LLM_CONCURRENCY
    : DEFAULT_LLM_CONCURRENCY;
}

interface WorkList {
  work: Node[];
  skipped: number;
}

function buildWorkList(
  graph: DriveGraph,
  resume: boolean | undefined
): WorkList {
  const work: Node[] = [];
  let skipped = 0;
  for (const id of graph.nodes()) {
    const node = graph.getNodeAttributes(id);
    if (!shouldExtract(node.mimeType)) {
      skipped += 1;
      continue;
    }
    if (
      resume &&
      ((node.summary != null && node.lastError == null) ||
        isPermanentErrorMessage(node.lastError))
    ) {
      continue;
    }
    work.push(node);
  }
  return { work, skipped };
}

interface ProcessOneParams {
  node: Node;
  graph: DriveGraph;
  llm: LlmProvider;
  opts: RunIndexOpts;
  stats: IndexStats;
  workDir: string;
  driveSem: ReturnType<typeof createSemaphore>;
  llmSem: ReturnType<typeof createSemaphore>;
}

async function processOne(p: ProcessOneParams): Promise<void> {
  const { node, graph, llm, opts, stats, workDir, driveSem, llmSem } = p;

  if (typeof node.size === 'number' && node.size > opts.maxSizeBytes) {
    opts.store.recordError(
      node.id,
      `skipped: too large (${node.size} bytes > ${opts.maxSizeBytes})`
    );
    stats.errors += 1;
    return;
  }

  // Phase 1 — Drive-bound: download + extract + hash. The drive permit is
  // released as soon as this phase ends so concurrent downloads keep
  // saturating the drive semaphore while phase-2 tasks wait on the LLM
  // semaphore.
  let markdown: string;
  let downloadMime: string;
  let hash: string;
  const releaseDrive = await driveSem.acquire();
  try {
    const destDir = join(workDir, node.id);
    const download = await downloadToFile(
      opts.client,
      { id: node.id, name: node.name, mimeType: node.mimeType },
      destDir,
      'auto',
      TEXT_EXPORT_MIME_MAP
    );
    downloadMime = download.mimeType;

    if (
      download.mimeType === 'text/plain' ||
      download.mimeType === 'text/csv'
    ) {
      markdown = await Bun.file(download.outputPath).text();
    } else {
      const raw = await Bun.file(download.outputPath).bytes();
      const bytes: Uint8Array =
        download.mimeType === 'application/pdf'
          ? await slicePdfToFirstPages(raw, opts.maxPdfPages)
          : raw;
      if (bytes.length > opts.maxSizeBytes) {
        opts.store.recordError(
          node.id,
          `skipped: too large after download (${bytes.length} bytes)`
        );
        stats.errors += 1;
        return;
      }
      markdown = await extractToMarkdown(bytes, download.mimeType);
    }
    stats.extracted += 1;

    hash = new Bun.CryptoHasher('sha256').update(markdown).digest('hex');
    if (node.contentHash === hash && node.summary) {
      return;
    }
  } catch (err) {
    stats.errors += 1;
    recordNodeFailure(opts.store, node, err);
    return;
  } finally {
    releaseDrive();
  }

  // Phase 2 — LLM-bound: summarize. Drive permit is already released, so
  // other tasks can download while this one blocks on the LLM semaphore.
  const releaseLlm = await llmSem.acquire();
  try {
    const summary = await llm.summarize({
      markdown,
      filename: node.name,
      path: nodePath(graph, node.id),
      mimeType: downloadMime,
    });
    const keyTopics = JSON.stringify(summary.keyTopics);
    opts.store.updateSummary(node.id, {
      summary: summary.summary,
      classification: summary.classification,
      keyTopics,
      extractedMd: markdown,
      contentHash: hash,
    });
    // Mirror the write onto the in-memory node so the embedding phase can
    // read fresh extractedMd/contentHash without a second hydrate from SQLite.
    node.summary = summary.summary;
    node.classification = summary.classification;
    node.keyTopics = keyTopics;
    node.extractedMd = markdown;
    node.contentHash = hash;
    node.lastError = null;
    stats.summarized += 1;
  } catch (err) {
    stats.errors += 1;
    recordNodeFailure(opts.store, node, err);
  } finally {
    releaseLlm();
  }
}

function recordNodeFailure(store: Store, node: Node, err: unknown): void {
  const rawMessage = err instanceof Error ? err.message : String(err);
  const info = classifyDriveError(err);
  if (info) {
    store.recordError(node.id, formatPermanentError(info, rawMessage));
    warn(
      `index: skipped ${describeNode(node)}: ${humanizePermanentReason(info.reason)}`
    );
    return;
  }
  store.recordError(node.id, rawMessage);
  warn(`index: ${describeNode(node)} failed: ${rawMessage}`);
}

function describeNode(node: Node): string {
  const size = typeof node.size === 'number' ? `, ${node.size}B` : '';
  return `"${node.name}" (${node.id}, ${node.mimeType}${size})`;
}

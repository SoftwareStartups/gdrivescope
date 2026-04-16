import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { drive_v3 } from '@googleapis/drive';
import { downloadToFile, TEXT_EXPORT_MIME_MAP } from '../drive/download.js';
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
import { warn } from '../utils/logging.js';
import { createSemaphore, withBackoff } from './concurrency.js';
import { computePruneSet } from './pruning.js';

// Whole-doc markdown often overruns a model's context window; embed the
// first EMBED_WINDOW characters (~500 tokens) at the document level. Per-
// chunk embeddings are deliberately deferred — `file search` ranks by
// document-level similarity, not passage-level.
const EMBED_WINDOW = 2000;
const DEFAULT_DRIVE_CONCURRENCY = 15;
const DEFAULT_LLM_CONCURRENCY = 4;

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
}

export async function runIndexPipeline(
  opts: RunIndexOpts
): Promise<IndexStats> {
  const seenIds = new Set<string>();
  const traverseStats = await traverseDriveFolder(opts.client, {
    rootId: opts.rootId,
    anchorRootId: opts.anchorRootId,
    scopeNode: opts.scopeNode,
    concurrency: opts.driveConcurrency ?? opts.concurrency,
    onNode: (n) => {
      seenIds.add(n.id);
      opts.store.upsertNode(n);
    },
  });
  const stats: IndexStats = {
    ...traverseStats,
    extracted: 0,
    summarized: 0,
    embedded: 0,
    skipped: 0,
    errors: 0,
    pruned: 0,
  };

  if (opts.prune) {
    const graph = hydrateGraph(opts.store);
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

  const llm = opts.llm;
  const driveConcurrency =
    opts.driveConcurrency ?? opts.concurrency ?? DEFAULT_DRIVE_CONCURRENCY;
  const llmConcurrency = opts.llmConcurrency ?? DEFAULT_LLM_CONCURRENCY;
  const driveSem = createSemaphore(Math.max(1, driveConcurrency));
  const llmSem = createSemaphore(Math.max(1, llmConcurrency));

  const workDir = mkdtempSync(join(tmpdir(), 'gdrivescope-'));
  try {
    const graph = hydrateGraph(opts.store);
    const { work, skipped } = buildWorkList(graph, opts.resume);
    stats.skipped += skipped;

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

    if (opts.embedding) {
      try {
        const embedding = opts.embedding;
        opts.store.initVectorTable(embedding.dimensions, {
          rebuild: opts.rebuildEmbeddings,
        });
        const freshGraph = hydrateGraph(opts.store);
        const toEmbed = freshGraph
          .nodes()
          .map((nid) => freshGraph.getNodeAttributes(nid))
          .filter(
            (n): n is typeof n & { extractedMd: string } =>
              n.extractedMd != null
          );
        if (toEmbed.length > 0) {
          const texts = toEmbed.map((n) =>
            n.extractedMd.slice(0, EMBED_WINDOW)
          );
          const vectors = await withBackoff(() => embedding.embed(texts));
          for (let i = 0; i < toEmbed.length; i += 1) {
            const node = toEmbed[i];
            const vec = vectors[i];
            if (!node || !vec) continue;
            opts.store.upsertEmbedding(node.id, new Float32Array(vec));
          }
          stats.embedded = toEmbed.length;
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
    if (resume && node.summary != null && node.lastError == null) continue;
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

    let markdown: string;
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

    const hash = new Bun.CryptoHasher('sha256').update(markdown).digest('hex');
    if (node.contentHash === hash && node.summary) {
      return;
    }

    const releaseLlm = await llmSem.acquire();
    try {
      const summary = await withBackoff(() =>
        llm.summarize({
          markdown,
          filename: node.name,
          path: nodePath(graph, node.id),
          mimeType: download.mimeType,
        })
      );
      opts.store.updateSummary(node.id, {
        summary: summary.summary,
        classification: summary.classification,
        keyTopics: JSON.stringify(summary.keyTopics),
        extractedMd: markdown,
        contentHash: hash,
      });
      stats.summarized += 1;
    } finally {
      releaseLlm();
    }
  } catch (err) {
    stats.errors += 1;
    const message = err instanceof Error ? err.message : String(err);
    opts.store.recordError(node.id, message);
    warn(`index: node ${node.id} failed: ${message}`);
  } finally {
    releaseDrive();
  }
}

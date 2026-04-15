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
import type { DriveNodeInput } from '../graph/model.js';
import { nodePath } from '../graph/paths.js';
import type { Store } from '../graph/store.js';
import type { EmbeddingProvider } from '../llm/embedding-provider.js';
import type { LlmProvider } from '../llm/provider.js';
import { warn } from '../utils/logging.js';

// Whole-doc markdown often overruns a model's context window; embed the
// first EMBED_WINDOW characters (~500 tokens) at the document level. Per-
// chunk embeddings are deliberately deferred — `file search` ranks by
// document-level similarity, not passage-level.
const EMBED_WINDOW = 2000;

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
  concurrency?: number;
}

export interface IndexStats extends TraverseResult {
  extracted: number;
  summarized: number;
  embedded: number;
  skipped: number;
  errors: number;
}

export async function runIndexPipeline(
  opts: RunIndexOpts
): Promise<IndexStats> {
  const traverseStats = await traverseDriveFolder(opts.client, {
    rootId: opts.rootId,
    anchorRootId: opts.anchorRootId,
    scopeNode: opts.scopeNode,
    concurrency: opts.concurrency,
    onNode: (n) => opts.store.upsertNode(n),
  });
  const stats: IndexStats = {
    ...traverseStats,
    extracted: 0,
    summarized: 0,
    embedded: 0,
    skipped: 0,
    errors: 0,
  };
  if (opts.metadataOnly || !opts.llm) return stats;

  const llm = opts.llm;
  const workDir = mkdtempSync(join(tmpdir(), 'gdrivescope-'));
  try {
    const graph = hydrateGraph(opts.store);
    for (const id of graph.nodes()) {
      const node = graph.getNodeAttributes(id);
      if (!shouldExtract(node.mimeType)) {
        stats.skipped += 1;
        continue;
      }
      if (typeof node.size === 'number' && node.size > opts.maxSizeBytes) {
        opts.store.recordError(
          id,
          `skipped: too large (${node.size} bytes > ${opts.maxSizeBytes})`
        );
        stats.errors += 1;
        continue;
      }
      try {
        const destDir = join(workDir, id);
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
          // Text exports from Google Docs/Slides/Sheets bypass Kreuzberg.
          markdown = await Bun.file(download.outputPath).text();
        } else {
          const raw = await Bun.file(download.outputPath).bytes();
          const bytes: Uint8Array =
            download.mimeType === 'application/pdf'
              ? await slicePdfToFirstPages(raw, opts.maxPdfPages)
              : raw;
          if (bytes.length > opts.maxSizeBytes) {
            opts.store.recordError(
              id,
              `skipped: too large after download (${bytes.length} bytes)`
            );
            stats.errors += 1;
            continue;
          }
          markdown = await extractToMarkdown(bytes, download.mimeType);
        }
        stats.extracted += 1;

        const hash = new Bun.CryptoHasher('sha256')
          .update(markdown)
          .digest('hex');
        if (node.contentHash === hash && node.summary) {
          // Idempotent skip: content unchanged since last run.
          continue;
        }

        const summary = await llm.summarize({
          markdown,
          filename: node.name,
          path: nodePath(graph, node.id),
          mimeType: download.mimeType,
        });
        opts.store.updateSummary(node.id, {
          summary: summary.summary,
          classification: summary.classification,
          keyTopics: JSON.stringify(summary.keyTopics),
          extractedMd: markdown,
          contentHash: hash,
        });
        stats.summarized += 1;
      } catch (err) {
        stats.errors += 1;
        const message = err instanceof Error ? err.message : String(err);
        opts.store.recordError(id, message);
        warn(`index: node ${id} failed: ${message}`);
      }
    }

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
          const vectors = await embedding.embed(texts);
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

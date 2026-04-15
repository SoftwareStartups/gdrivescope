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
import type { LlmProvider } from '../llm/provider.js';
import { warn } from '../utils/logging.js';

export interface RunIndexOpts {
  store: Store;
  client: drive_v3.Drive;
  rootId: string;
  metadataOnly: boolean;
  llm: LlmProvider | null;
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
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return stats;
}

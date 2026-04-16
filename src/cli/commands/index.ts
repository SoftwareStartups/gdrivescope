import {
  type ConfigRoot,
  loadWorkspaceConfig,
  resolveFolder,
  saveWorkspaceConfig,
  upsertRoot,
} from '../../config/workspace.js';
import { resolveAncestry } from '../../drive/ancestry.js';
import { createDriveClient } from '../../drive/client.js';
import { openStore } from '../../graph/store.js';
import { resolveEmbeddingProvider } from '../../llm/embedding-resolver.js';
import { resolveLlmProvider } from '../../llm/resolver.js';
import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { runIndexPipeline } from '../../pipeline/index-pipeline.js';
import { getDbPath } from '../../utils/config.js';
import { toResponse } from '../../utils/errors.js';
import { warn } from '../../utils/logging.js';
import {
  parseOptionalPositiveInt,
  parsePositiveInt,
} from '../../utils/parse.js';

export interface IndexFlags {
  scope?: string;
  root?: string;
  'add-root'?: boolean;
  'metadata-only'?: boolean;
  concurrency?: string;
  'concurrency-drive'?: string;
  'concurrency-llm'?: string;
  resume?: boolean;
  prune?: boolean;
  provider?: string;
  'embedding-provider'?: string;
  'rebuild-embeddings'?: boolean;
  'max-size'?: string;
  'max-pdf-pages'?: string;
}

export interface IndexData {
  rootId: string;
  rootLabel: string;
  scopeId: string;
  ancestryPath: string[];
  dbPath: string;
  visited: number;
  folders: number;
  files: number;
  extracted: number;
  summarized: number;
  embedded: number;
  skipped: number;
  errors: number;
  pruned: number;
  usedFallback: boolean;
}

export const HELP = `gdrivescope index — Build or refresh the persistent Drive graph

Traverses a Drive folder (and all descendants) and persists metadata into
\`~/.config/gdrivescope/drive.db\`. Re-running is idempotent: existing rows are
updated in place, \`last_indexed\` advances, and \`meta.last_index_run\` is
stamped on each successful run.

By default, each extractable file is downloaded, passed through Kreuzberg for
markdown extraction, and summarized via the configured LLM provider. Google
Workspace files (Docs/Sheets/Slides) are exported as text/CSV server-side and
skip Kreuzberg entirely. Large PDFs are sliced to the first \`--max-pdf-pages\`
before extraction to cap CPU cost.

Use \`--metadata-only\` to restore Stage 3 behavior (no extraction, no LLM,
no cost).

When one or more roots are configured in \`config.toml\`, indexing a deeper
\`--scope\` folder also stitches the folder chain from the configured root
down to the scope into the graph.

Usage:
  gdrivescope index [options]

Options:
  --scope <FOLDER_ID>          Start folder id or alias (default: \`root\`)
  --root <FOLDER_ID>           One-shot root override (bypasses config.toml)
  --add-root                   Persist the resolved root to config.toml
  --metadata-only              Skip extraction + LLM summarization + embeddings
  --concurrency <N>            Shorthand for --concurrency-drive
  --concurrency-drive <N>      Max parallel Drive API calls (default 15)
  --concurrency-llm <N>        Max parallel LLM/embedding calls (default 4)
  --resume                     Only process nodes without a summary or with a recorded error
  --prune                      Delete store rows for files no longer visible in Drive (scoped)
  --provider <NAME>            LLM provider: anthropic (default) | openai
  --embedding-provider <NAME>  Embedding provider: openai (default) | voyage
  --rebuild-embeddings         Drop + recreate the vector table at the current provider's dimension
  --max-size <BYTES>           Skip files larger than this (default 20971520 = 20MB)
  --max-pdf-pages <N>          Slice PDFs to first N pages before extraction (default 10)
  --json                       Emit JSON envelope

Environment:
  ANTHROPIC_API_KEY                Required for --provider anthropic
  OPENAI_API_KEY                   Required for --provider openai and default --embedding-provider openai
  VOYAGE_API_KEY                   Required for --embedding-provider voyage
  GDRIVESCOPE_LLM_PROVIDER         Default LLM provider (flag > env > config > anthropic)
  GDRIVESCOPE_EMBEDDING_PROVIDER   Default embedding provider (flag > env > config > openai)
  GDRIVESCOPE_MAX_SIZE             Default --max-size value
  GDRIVESCOPE_MAX_PDF_PAGES        Default --max-pdf-pages value
`;

const DEFAULT_MAX_SIZE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_PDF_PAGES = 10;

function resolveMaxSize(
  flag: string | undefined,
  cfgValue: number | undefined
): number {
  if (flag !== undefined) {
    return parsePositiveInt('max-size', flag, DEFAULT_MAX_SIZE_BYTES);
  }
  const env = Bun.env.GDRIVESCOPE_MAX_SIZE;
  if (env !== undefined) {
    return parsePositiveInt('max-size', env, DEFAULT_MAX_SIZE_BYTES);
  }
  if (cfgValue !== undefined) return cfgValue;
  return DEFAULT_MAX_SIZE_BYTES;
}

function resolveMaxPdfPages(
  flag: string | undefined,
  cfgValue: number | undefined
): number {
  if (flag !== undefined) {
    return parsePositiveInt('max-pdf-pages', flag, DEFAULT_MAX_PDF_PAGES);
  }
  const env = Bun.env.GDRIVESCOPE_MAX_PDF_PAGES;
  if (env !== undefined) {
    return parsePositiveInt('max-pdf-pages', env, DEFAULT_MAX_PDF_PAGES);
  }
  if (cfgValue !== undefined) return cfgValue;
  return DEFAULT_MAX_PDF_PAGES;
}

export async function run(flags: IndexFlags): Promise<ApiResponse<IndexData>> {
  const dbPath = getDbPath();
  const store = openStore(dbPath);
  try {
    const cfg = await loadWorkspaceConfig();
    const client = await createDriveClient();
    const rawScope = flags.scope ?? 'root';
    const scopeId = resolveFolder(cfg, rawScope);
    const driveConcurrency =
      parseOptionalPositiveInt(
        'concurrency-drive',
        flags['concurrency-drive']
      ) ?? parseOptionalPositiveInt('concurrency', flags.concurrency);
    const llmConcurrency = parseOptionalPositiveInt(
      'concurrency-llm',
      flags['concurrency-llm']
    );
    const metadataOnly = flags['metadata-only'] === true;
    const maxSizeBytes = resolveMaxSize(
      flags['max-size'],
      cfg.extraction?.maxSizeBytes
    );
    const maxPdfPages = resolveMaxPdfPages(
      flags['max-pdf-pages'],
      cfg.extraction?.maxPdfPages
    );

    const llm = metadataOnly
      ? null
      : resolveLlmProvider({
          flagProvider: flags.provider,
          configProvider: cfg.llm?.provider,
        });
    const embedding = metadataOnly
      ? null
      : resolveEmbeddingProvider({
          flagProvider: flags['embedding-provider'],
          configProvider: cfg.embedding?.provider,
        });

    const configuredRoots: ConfigRoot[] = flags.root
      ? [{ id: flags.root }]
      : cfg.roots;

    const ancestry = await resolveAncestry(client, scopeId, configuredRoots);

    if (ancestry.usedFallback && configuredRoots.length > 0) {
      warn(
        `scope ${scopeId} is not under any configured root; indexing as a standalone tree. ` +
          'Add it with: gdrivescope config add-root <FOLDER_ID>'
      );
    }

    // Emit ancestor chain first (root → scope.parent), then scope itself,
    // then let the pipeline pick up descendants from the scope node.
    for (const node of ancestry.chain) {
      store.upsertNode(node);
    }
    store.upsertNode(ancestry.scope);

    const stats = await runIndexPipeline({
      store,
      client,
      rootId: ancestry.scope.id,
      anchorRootId: ancestry.rootId,
      scopeNode: ancestry.scope,
      driveConcurrency,
      llmConcurrency,
      resume: flags.resume === true,
      prune: flags.prune === true,
      metadataOnly,
      llm,
      embedding,
      rebuildEmbeddings: flags['rebuild-embeddings'] === true,
      maxSizeBytes,
      maxPdfPages,
    });

    // +1 for the scope emitted ahead of the pipeline; pipeline counts descendants.
    const visited = stats.visited + 1 + ancestry.chain.length;
    const folders = stats.folders + 1 + ancestry.chain.length;
    const files = stats.files;

    store.setMeta('last_index_run', new Date().toISOString());

    if (flags['add-root'] && !ancestry.usedFallback) {
      const updated = upsertRoot(cfg, {
        id: ancestry.rootId,
        label: ancestry.rootLabel,
      });
      await saveWorkspaceConfig(updated);
    }

    const ancestryPath = [
      ...ancestry.chain.map((n) => n.name),
      ancestry.scope.name,
    ];
    const displayPath =
      ancestry.chain.length === 0
        ? [ancestry.rootLabel]
        : [ancestry.rootLabel, ...ancestryPath.slice(1)];

    return success({
      rootId: ancestry.rootId,
      rootLabel: ancestry.rootLabel,
      scopeId: ancestry.scope.id,
      ancestryPath: displayPath,
      dbPath,
      visited,
      folders,
      files,
      extracted: stats.extracted,
      summarized: stats.summarized,
      embedded: stats.embedded,
      skipped: stats.skipped,
      errors: stats.errors,
      pruned: stats.pruned,
      usedFallback: ancestry.usedFallback,
    });
  } catch (err) {
    return toResponse(err);
  } finally {
    store.close();
  }
}

export function render(data: IndexData): string {
  const path = data.ancestryPath.join(' / ');
  const lines = [
    `Indexed ${data.visited} node(s) under ${path}`,
    `  root:       ${data.rootLabel} (${data.rootId})`,
    `  folders:    ${data.folders}`,
    `  files:      ${data.files}`,
    `  extracted:  ${data.extracted}`,
    `  summarized: ${data.summarized}`,
    `  embedded:   ${data.embedded}`,
    `  skipped:    ${data.skipped}`,
    `  errors:     ${data.errors}`,
    `  pruned:     ${data.pruned}`,
    `  db:         ${data.dbPath}`,
  ];
  if (data.usedFallback) {
    lines.push(
      '  note:       scope is not under any configured root — indexed as a standalone tree'
    );
  }
  return lines.join('\n');
}

import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import {
  type ConfigRoot,
  loadWorkspaceConfig,
  resolveFolder,
  saveWorkspaceConfig,
  upsertRoot,
} from '../../config/workspace.js';
import { createDriveClient } from '../../drive/client.js';
import { resolveAncestry } from '../../drive/ancestry.js';
import { traverseDriveFolder } from '../../drive/traversal.js';
import { openStore } from '../../graph/store.js';
import { getDbPath } from '../../utils/config.js';
import { warn } from '../../utils/logging.js';
import { toResponse } from '../../utils/errors.js';

export interface IndexFlags {
  scope?: string;
  root?: string;
  'add-root'?: boolean;
  'metadata-only'?: boolean;
  concurrency?: string;
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
  usedFallback: boolean;
}

export const HELP = `gdrivescope index — Build or refresh the persistent Drive graph

Traverses a Drive folder (and all descendants) and persists metadata into
\`~/.config/gdrivescope/drive.db\`. Re-running is idempotent: existing rows are
updated in place, \`last_indexed\` advances, and \`meta.last_index_run\` is
stamped on each successful run.

When one or more roots are configured in \`config.toml\`, indexing a deeper
\`--scope\` folder also stitches the folder chain from the configured root down
to the scope into the graph, so sibling indexes share a common ancestry.

Usage:
  gdrivescope index [options]

Options:
  --scope <FOLDER_ID>     Start folder id or alias (default: \`root\` — My Drive)
  --root <FOLDER_ID>      One-shot root override (bypasses config.toml)
  --add-root              Persist the resolved root to config.toml after a
                          successful run (useful for first-time setup)
  --metadata-only         Skip extraction + LLM summarization (Stage 3 default)
  --concurrency <N>       Max parallel files.list calls (default 4, max 15)
  --json                  Emit JSON envelope instead of human-readable output

Shared drives: if the logged-in account has access to a shared drive, pass the
shared drive folder id as --scope (optionally add it as a root). No additional
flag is required.

Notes:
  --metadata-only is always on in this release. Full-text extraction and
  embeddings ship in later stages.
`;

function parseConcurrency(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new Error(`invalid --concurrency value: ${value}`);
  }
  return Math.trunc(n);
}

export async function run(flags: IndexFlags): Promise<ApiResponse<IndexData>> {
  const dbPath = getDbPath();
  const store = openStore(dbPath);
  try {
    const cfg = await loadWorkspaceConfig();
    const client = await createDriveClient();
    const rawScope = flags.scope ?? 'root';
    const scopeId = resolveFolder(cfg, rawScope);
    const concurrency = parseConcurrency(flags.concurrency);

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
    // then let the BFS pick up descendants from the scope node.
    for (const node of ancestry.chain) {
      store.upsertNode(node);
    }
    store.upsertNode(ancestry.scope);

    const result = await traverseDriveFolder(client, {
      rootId: ancestry.scope.id,
      anchorRootId: ancestry.rootId,
      scopeNode: ancestry.scope,
      concurrency,
      onNode: (node) => store.upsertNode(node),
    });

    // +1 for scope emitted ahead of the BFS; BFS only counts descendants.
    const visited = result.visited + 1 + ancestry.chain.length;
    const folders = result.folders + 1 + ancestry.chain.length;
    const files = result.files;

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
    // When the scope is itself the root, chain is empty and the first segment
    // is the scope (which equals the root). Prepend rootLabel otherwise.
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
    `  root:    ${data.rootLabel} (${data.rootId})`,
    `  folders: ${data.folders}`,
    `  files:   ${data.files}`,
    `  db:      ${data.dbPath}`,
  ];
  if (data.usedFallback) {
    lines.push(
      '  note:    scope is not under any configured root — indexed as a standalone tree'
    );
  }
  return lines.join('\n');
}

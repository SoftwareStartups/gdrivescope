import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { createDriveClient } from '../../drive/client.js';
import { traverseDriveFolder } from '../../drive/traversal.js';
import { openStore } from '../../graph/store.js';
import { getDbPath } from '../../utils/config.js';
import { toResponse } from '../../utils/errors.js';

export interface IndexFlags {
  scope?: string;
  'metadata-only'?: boolean;
  concurrency?: string;
}

export interface IndexData {
  rootId: string;
  dbPath: string;
  visited: number;
  folders: number;
  files: number;
}

export const HELP = `gdrivescope index — Build or refresh the persistent Drive graph

Traverses a Drive folder (and all descendants) and persists metadata into
\`~/.config/gdrivescope/drive.db\`. Re-running is idempotent: existing rows are
updated in place, \`last_indexed\` advances, and \`meta.last_index_run\` is
stamped on each successful run.

Usage:
  gdrivescope index [options]

Options:
  --scope <FOLDER_ID>     Start folder id (default: \`root\` — My Drive root)
  --metadata-only         Skip extraction + LLM summarization (Stage 3 default)
  --concurrency <N>       Max parallel files.list calls (default 4, max 15)
  --json                  Emit JSON envelope instead of human-readable output

Shared drives: if the logged-in account has access to a shared drive, pass the
shared drive folder id as --scope. No additional flag is required.

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
    const client = await createDriveClient();
    const rootId = flags.scope ?? 'root';
    const concurrency = parseConcurrency(flags.concurrency);
    const result = await traverseDriveFolder(client, {
      rootId,
      concurrency,
      onNode: (node) => store.upsertNode(node),
    });
    store.setMeta('last_index_run', new Date().toISOString());
    return success({
      rootId,
      dbPath,
      visited: result.visited,
      folders: result.folders,
      files: result.files,
    });
  } catch (err) {
    return toResponse(err);
  } finally {
    store.close();
  }
}

export function render(data: IndexData): string {
  return [
    `Indexed ${data.visited} node(s) under ${data.rootId}`,
    `  folders: ${data.folders}`,
    `  files:   ${data.files}`,
    `  db:      ${data.dbPath}`,
  ].join('\n');
}

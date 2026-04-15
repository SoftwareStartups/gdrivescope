import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { hydrateGraph } from '../../graph/hydrate.js';
import { descendants, nodePath } from '../../graph/paths.js';
import { openStore, type Store } from '../../graph/store.js';
import { getDbPath } from '../../utils/config.js';
import { CliError, toResponse } from '../../utils/errors.js';

export interface FileListFlags {
  _positional?: string;
  recursive?: boolean;
  r?: boolean;
  limit?: string;
}

export interface FileListEntry {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  path: string;
}

export interface FileListData {
  startId: string;
  recursive: boolean;
  files: FileListEntry[];
}

export const HELP = `gdrivescope file list — List files under a folder from the indexed graph

Usage:
  gdrivescope file list [FOLDER_ID] [options]

Arguments:
  FOLDER_ID          Starting folder id (default: \`root\` — My Drive root)

Options:
  -r, --recursive    Recurse into subfolders
  --limit <N>        Maximum rows to emit (default 200)
  --json             Emit JSON envelope instead of human-readable output
`;

function parseLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new CliError(`invalid --limit value: ${value}`, 'USAGE');
  }
  return Math.trunc(n);
}

export async function run(
  flags: FileListFlags
): Promise<ApiResponse<FileListData>> {
  let store: Store | null = null;
  try {
    store = openStore(getDbPath());
    const graph = hydrateGraph(store);
    const startId = flags._positional ?? 'root';
    if (!graph.hasNode(startId)) {
      throw new CliError(
        `No node ${startId} in index. Run \`gdrivescope index\` first.`,
        'NODE_NOT_FOUND'
      );
    }
    const recursive = Boolean(flags.recursive || flags.r);
    const limit = parseLimit(flags.limit, 200);

    const ids = recursive
      ? [...descendants(graph, startId)]
      : graph.outNeighbors(startId);

    const files: FileListEntry[] = ids
      .map((id) => graph.getNodeAttributes(id))
      .map((n) => ({
        id: n.id,
        name: n.name,
        mimeType: n.mimeType,
        size: n.size ?? null,
        path: nodePath(graph, n.id),
      }))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, limit);

    return success({ startId, recursive, files });
  } catch (err) {
    return toResponse(err);
  } finally {
    store?.close();
  }
}

function formatSize(size: number | null): string {
  if (size === null || size === undefined) return '—';
  if (size < 1024) return `${size}B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}K`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)}M`;
  return `${(mb / 1024).toFixed(1)}G`;
}

export function render(data: FileListData): string {
  if (data.files.length === 0) {
    return `No files under ${data.startId}.`;
  }
  const header = `${data.files.length} file(s) under ${data.startId}${data.recursive ? ' (recursive)' : ''}:`;
  const rows = data.files.map(
    (f) => `  ${formatSize(f.size).padStart(7)}  ${f.path}`
  );
  return [header, ...rows].join('\n');
}

import { loadWorkspaceConfig, resolveFolder } from '../../config/workspace.js';
import { hydrateGraph } from '../../graph/hydrate.js';
import type { DriveGraph } from '../../graph/model.js';
import { descendants, nodePath } from '../../graph/paths.js';
import { withStoreAsync } from '../../graph/store.js';
import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { getDbPath } from '../../utils/config.js';
import { CliError, toResponse } from '../../utils/errors.js';
import { parsePositiveInt } from '../../utils/parse.js';

const ROOT_SENTINELS = new Set(['root', 'my-drive']);
const WORKSPACE_MARKER = '(workspace)';

function findRootNodeIds(graph: DriveGraph): string[] {
  return graph
    .nodes()
    .filter((id) => graph.getNodeAttributes(id).parentId === null);
}

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
  gdrivescope file list [FOLDER_ID|NAME] [options]

Arguments:
  FOLDER_ID|NAME     Starting folder — Drive id, configured folder alias,
                     or \`root\`/\`my-drive\` (default: workspace roots).
                     With multiple configured roots and no argument, lists
                     the roots themselves.

Options:
  -r, --recursive    Recurse into subfolders
  --limit <N>        Maximum rows to emit (default 200)
  --json             Emit JSON envelope instead of human-readable output
`;

function buildEntries(
  graph: DriveGraph,
  ids: readonly string[],
  limit: number
): FileListEntry[] {
  return ids
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
}

export async function run(
  flags: FileListFlags
): Promise<ApiResponse<FileListData>> {
  try {
    const cfg = await loadWorkspaceConfig();
    return await withStoreAsync(getDbPath(), async (store) => {
      const graph = hydrateGraph(store);
      const recursive = Boolean(flags.recursive || flags.r);
      const limit = parsePositiveInt('limit', flags.limit, 200);
      const positional = flags._positional;
      const wantsRoot =
        positional === undefined || ROOT_SENTINELS.has(positional);

      if (wantsRoot) {
        const rootIds = findRootNodeIds(graph);
        if (rootIds.length === 0) {
          throw new CliError(
            'No nodes in index. Run `gdrivescope index` first.',
            'NODE_NOT_FOUND'
          );
        }
        if (rootIds.length === 1) {
          const startId = rootIds[0] as string;
          const ids = recursive
            ? [...descendants(graph, startId)]
            : graph.outNeighbors(startId);
          return success({
            startId,
            recursive,
            files: buildEntries(graph, ids, limit),
          });
        }
        // Multiple roots: synthesize a listing of the roots themselves.
        const ids = recursive
          ? rootIds.flatMap((r) => [r, ...descendants(graph, r)])
          : rootIds;
        return success({
          startId: WORKSPACE_MARKER,
          recursive,
          files: buildEntries(graph, ids, limit),
        });
      }

      const resolved = resolveFolder(cfg, positional);
      if (!graph.hasNode(resolved)) {
        throw new CliError(
          `No node ${resolved} in index. Run \`gdrivescope index\` first.`,
          'NODE_NOT_FOUND'
        );
      }
      const ids = recursive
        ? [...descendants(graph, resolved)]
        : graph.outNeighbors(resolved);
      return success({
        startId: resolved,
        recursive,
        files: buildEntries(graph, ids, limit),
      });
    });
  } catch (err) {
    return toResponse(err);
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

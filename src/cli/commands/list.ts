import { loadWorkspaceConfig, resolveFolder } from '../../config/workspace.js';
import { hydrateGraph } from '../../graph/hydrate.js';
import type { DriveGraph } from '../../graph/model.js';
import { descendants, nodePath } from '../../graph/paths.js';
import { withStoreAsync } from '../../graph/store.js';
import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { getDbPath } from '../../utils/config.js';
import { CliError, toResponse } from '../../utils/errors.js';
import {
  classifyNodeType,
  isNodeType,
  NODE_TYPES,
  type NodeType,
} from '../../utils/node-type.js';
import { parsePositiveInt } from '../../utils/parse.js';

const ROOT_SENTINELS = new Set(['root', 'my-drive']);
const WORKSPACE_MARKER = '(workspace)';

function findRootNodeIds(graph: DriveGraph): string[] {
  return graph
    .nodes()
    .filter((id) => graph.getNodeAttributes(id).parentId === null);
}

export interface ListFlags {
  _positional?: string;
  recursive?: boolean;
  r?: boolean;
  limit?: string;
  type?: string;
}

export interface ListEntry {
  id: string;
  name: string;
  mimeType: string;
  size: number | null;
  path: string;
}

export interface ListData {
  startId: string;
  recursive: boolean;
  type: NodeType | null;
  files: ListEntry[];
}

export const HELP = `gdrivescope list — List entries under a folder from the indexed graph

Usage:
  gdrivescope list [FOLDER_ID|NAME] [options]

Arguments:
  FOLDER_ID|NAME     Starting folder — Drive id, configured folder alias,
                     or \`root\`/\`my-drive\` (default: workspace roots).
                     With multiple configured roots and no argument, lists
                     the roots themselves.

Options:
  -r, --recursive    Recurse into subfolders
  --type <KIND>      Filter by node kind: ${NODE_TYPES.join(' | ')}
                     - folder:   Drive folders
                     - file:     extractable content (Docs, PDFs, Office, …)
                     - shortcut: Drive shortcuts
                     - other:    forms / sites / images / audio / video
  --limit <N>        Maximum rows to emit (default 200)
  --json             Emit JSON envelope instead of human-readable output
`;

function parseTypeFilter(value: string | undefined): NodeType | null {
  if (value === undefined) return null;
  if (!isNodeType(value)) {
    throw new CliError(
      `invalid --type value: ${value} (expected ${NODE_TYPES.join('|')})`,
      'USAGE'
    );
  }
  return value;
}

function buildEntries(
  graph: DriveGraph,
  ids: readonly string[],
  limit: number,
  type: NodeType | null
): ListEntry[] {
  return ids
    .map((id) => graph.getNodeAttributes(id))
    .filter((n) => (type ? classifyNodeType(n.mimeType) === type : true))
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

export async function run(flags: ListFlags): Promise<ApiResponse<ListData>> {
  try {
    const type = parseTypeFilter(flags.type);
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
            type,
            files: buildEntries(graph, ids, limit, type),
          });
        }
        // Multiple roots: synthesize a listing of the roots themselves.
        const ids = recursive
          ? rootIds.flatMap((r) => [r, ...descendants(graph, r)])
          : rootIds;
        return success({
          startId: WORKSPACE_MARKER,
          recursive,
          type,
          files: buildEntries(graph, ids, limit, type),
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
        type,
        files: buildEntries(graph, ids, limit, type),
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

export function render(data: ListData): string {
  const filterSuffix = data.type ? ` [${data.type}]` : '';
  if (data.files.length === 0) {
    return `No entries under ${data.startId}${filterSuffix}.`;
  }
  const recursiveSuffix = data.recursive ? ' (recursive)' : '';
  const header = `${data.files.length} entry/entries under ${data.startId}${recursiveSuffix}${filterSuffix}:`;
  const rows = data.files.map(
    (f) => `  ${formatSize(f.size).padStart(7)}  ${f.path}`
  );
  return [header, ...rows].join('\n');
}

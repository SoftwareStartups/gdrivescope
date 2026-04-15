import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { hydrateGraph } from '../../graph/hydrate.js';
import { descendants, nodePath } from '../../graph/paths.js';
import { openStore, type Store } from '../../graph/store.js';
import { getDbPath } from '../../utils/config.js';
import { CliError, toResponse } from '../../utils/errors.js';

export interface FileSearchFlags {
  _positional?: string;
  classification?: string;
  scope?: string;
  limit?: string;
  threshold?: string;
  mode?: 'name' | 'semantic';
}

export interface FileSearchHit {
  id: string;
  name: string;
  mimeType: string;
  path: string;
  score: number | null;
}

export interface FileSearchData {
  query: string;
  hits: FileSearchHit[];
}

export const HELP = `gdrivescope file search — Search the indexed graph by file name

Usage:
  gdrivescope file search <QUERY> [options]

Options:
  --classification <VAL>   Filter by classification (Stage 5+)
  --scope <FOLDER_ID>      Restrict to descendants of a folder
  --limit <N>              Max hits (default 20)
  --threshold <X>          Reserved — semantic search not yet available
  --json                   Emit JSON envelope instead of human-readable output
`;

interface NodeRow {
  id: string;
  name: string;
  mime_type: string;
  parent_id: string | null;
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) {
    throw new CliError(`invalid --limit value: ${value}`, 'USAGE');
  }
  return Math.trunc(n);
}

export async function run(
  flags: FileSearchFlags
): Promise<ApiResponse<FileSearchData>> {
  if (flags.threshold !== undefined || flags.mode === 'semantic') {
    return toResponse(
      new CliError(
        'Semantic search is not available in this build. Rerun `gdrivescope index` after upgrading to include embeddings.',
        'NOT_YET_IMPLEMENTED'
      )
    );
  }
  if (!flags._positional) {
    return toResponse(
      new CliError('Usage: gdrivescope file search <QUERY>', 'MISSING_ARG')
    );
  }
  let store: Store | null = null;
  try {
    store = openStore(getDbPath());
    const query = flags._positional.toLowerCase();
    const limit = parseLimit(flags.limit, 20);

    const graph = hydrateGraph(store);
    const scopeSet = flags.scope ? descendants(graph, flags.scope) : null;

    const sql = flags.classification
      ? 'SELECT id, name, mime_type, parent_id FROM nodes WHERE LOWER(name) LIKE ? AND classification = ?'
      : 'SELECT id, name, mime_type, parent_id FROM nodes WHERE LOWER(name) LIKE ?';
    const stmt = store.db.prepare(sql);
    const rows = (
      flags.classification
        ? stmt.all(`%${query}%`, flags.classification)
        : stmt.all(`%${query}%`)
    ) as NodeRow[];

    const hits: FileSearchHit[] = rows
      .map((r) => ({
        id: r.id,
        name: r.name,
        mimeType: r.mime_type,
        path: nodePath(graph, r.id),
        score: null as number | null,
        _exact: r.name.toLowerCase() === query,
        _len: r.name.length,
      }))
      .filter((h) => (scopeSet ? scopeSet.has(h.id) : true))
      .sort((a, b) => {
        if (a._exact !== b._exact) return a._exact ? -1 : 1;
        if (a._len !== b._len) return a._len - b._len;
        return a.name.localeCompare(b.name);
      })
      .slice(0, limit)
      .map(({ _exact: _e, _len: _l, ...rest }) => rest);

    return success({ query: flags._positional, hits });
  } catch (err) {
    return toResponse(err);
  } finally {
    store?.close();
  }
}

export function render(data: FileSearchData): string {
  if (data.hits.length === 0) {
    return `No matches for "${data.query}".`;
  }
  const header = `${data.hits.length} hit(s) for "${data.query}":`;
  const rows = data.hits.map((h) => `  ${h.path}  (${h.mimeType})`);
  return [header, ...rows].join('\n');
}

import { loadWorkspaceConfig } from '../../config/workspace.js';
import { hydrateGraph } from '../../graph/hydrate.js';
import { descendants, nodePath } from '../../graph/paths.js';
import { withStoreAsync } from '../../graph/store.js';
import { resolveEmbeddingProvider } from '../../llm/embedding-resolver.js';
import type { ApiResponse } from '../../models/api-response.js';
import { success } from '../../models/api-response.js';
import { semanticSearch } from '../../search/vector-search.js';
import { getDbPath } from '../../utils/config.js';
import { CliError, toResponse } from '../../utils/errors.js';
import { parsePositiveInt } from '../../utils/parse.js';

export type FileSearchMode = 'name' | 'semantic';

export interface FileSearchFlags {
  _positional?: string;
  classification?: string;
  scope?: string;
  limit?: string;
  threshold?: string;
  mode?: FileSearchMode;
  'embedding-provider'?: string;
}

export interface FileSearchHit {
  id: string;
  name: string;
  mimeType: string;
  path: string;
  score: number | null;
  classification?: string | null;
}

export interface FileSearchData {
  query: string;
  mode: FileSearchMode;
  hits: FileSearchHit[];
}

export const HELP = `gdrivescope file search — Search the indexed graph

Runs in one of two modes:
- semantic (default when embeddings exist): cosine-similarity search over the
  vector table populated by \`gdrivescope index\`. Requires an embedding
  provider to embed the query.
- name (Stage 4 fallback): substring match on file name, ranked by exactness
  and length. Used automatically when no embeddings are present.

Usage:
  gdrivescope file search <QUERY> [options]

Options:
  --mode <name|semantic>       Force a specific backend (default: auto)
  --classification <VAL>       Filter by classification
  --scope <FOLDER_ID>          Restrict to descendants of a folder
  --limit <N>                  Max hits (default 20)
  --threshold <X>              Minimum cosine similarity (semantic only)
  --embedding-provider <NAME>  Embedding provider: openai (default) | voyage
  --json                       Emit JSON envelope

Environment:
  OPENAI_API_KEY                  Required for semantic search with openai
  VOYAGE_API_KEY                  Required for semantic search with voyage
  GDRIVESCOPE_EMBEDDING_PROVIDER  Default embedding provider
`;

function parseThreshold(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new CliError(`invalid --threshold value: ${value}`, 'USAGE');
  }
  return n;
}

export async function run(
  flags: FileSearchFlags
): Promise<ApiResponse<FileSearchData>> {
  if (!flags._positional) {
    return toResponse(
      new CliError('Usage: gdrivescope file search <QUERY>', 'MISSING_ARG')
    );
  }
  try {
    return await withStoreAsync(getDbPath(), async (store) => {
      const hasEmbeddings = store.hasVectorTable();
      const mode: FileSearchMode =
        flags.mode ?? (hasEmbeddings ? 'semantic' : 'name');
      const limit = parsePositiveInt('limit', flags.limit, 20);

      if (mode === 'semantic') {
        if (!hasEmbeddings) {
          throw new CliError(
            'No embeddings in store. Run `gdrivescope index --scope X` first.',
            'NO_EMBEDDINGS'
          );
        }
        const cfg = await loadWorkspaceConfig();
        const provider = resolveEmbeddingProvider({
          flagProvider: flags['embedding-provider'],
          configProvider: cfg.embedding?.provider,
        });
        const graph = hydrateGraph(store);
        const hits = await semanticSearch({
          query: flags._positional!,
          provider,
          store,
          graph,
          limit,
          threshold: parseThreshold(flags.threshold),
          scope: flags.scope,
          classification: flags.classification,
        });
        return success({
          query: flags._positional!,
          mode,
          hits: hits.map((h) => ({
            id: h.id,
            name: h.name,
            mimeType: h.mimeType,
            path: h.path,
            score: h.score,
            classification: h.classification,
          })),
        });
      }

      // Name-mode fallback.
      const query = flags._positional!.toLowerCase();
      const graph = hydrateGraph(store);
      const scopeSet = flags.scope ? descendants(graph, flags.scope) : null;

      const rows = store.searchByName(query, flags.classification ?? undefined);

      const hits: FileSearchHit[] = rows
        .map((r) => ({
          id: r.id,
          name: r.name,
          mimeType: r.mimeType,
          path: nodePath(graph, r.id),
          score: null as number | null,
          classification: r.classification,
        }))
        .filter((h) => (scopeSet ? scopeSet.has(h.id) : true))
        .sort((a, b) => {
          const aExact = a.name.toLowerCase() === query;
          const bExact = b.name.toLowerCase() === query;
          if (aExact !== bExact) return aExact ? -1 : 1;
          if (a.name.length !== b.name.length)
            return a.name.length - b.name.length;
          return a.name.localeCompare(b.name);
        })
        .slice(0, limit);

      return success({ query: flags._positional!, mode: 'name', hits });
    });
  } catch (err) {
    return toResponse(err);
  }
}

export function render(data: FileSearchData): string {
  if (data.hits.length === 0) {
    return `No matches for "${data.query}" (${data.mode} mode).`;
  }
  const header = `${data.hits.length} hit(s) for "${data.query}" (${data.mode} mode):`;
  const rows = data.hits.map((h) => {
    const score = h.score !== null ? `  [${h.score.toFixed(3)}]` : '';
    return `  ${h.path}  (${h.mimeType})${score}`;
  });
  return [header, ...rows].join('\n');
}

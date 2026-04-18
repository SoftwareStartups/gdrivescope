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
import {
  classifyNodeType,
  isNodeType,
  NODE_TYPES,
  type NodeType,
} from '../../utils/node-type.js';
import { parsePositiveInt } from '../../utils/parse.js';

export type SearchMode = 'name' | 'semantic';

export interface SearchFlags {
  _positional?: string;
  classification?: string;
  scope?: string;
  limit?: string;
  threshold?: string;
  mode?: SearchMode;
  type?: string;
  'embedding-provider'?: string;
}

export interface SearchHit {
  id: string;
  name: string;
  mimeType: string;
  path: string;
  score: number | null;
  classification?: string | null;
}

export interface SearchData {
  query: string;
  mode: SearchMode;
  type: NodeType | null;
  hits: SearchHit[];
}

export const HELP = `gdrivescope search — Search the indexed graph

Runs in one of two modes:
- semantic (default when embeddings exist): cosine-similarity search over the
  vector table populated by \`gdrivescope index\`. Requires an embedding
  provider to embed the query.
- name (Stage 4 fallback): substring match on entry name, ranked by exactness
  and length. Used automatically when no embeddings are present.

Usage:
  gdrivescope search <QUERY> [options]

Options:
  --mode <name|semantic>       Force a specific backend (default: auto)
  --type <KIND>                Filter by node kind: ${NODE_TYPES.join(' | ')}
                               Note: only \`file\` entries are embedded, so
                               \`--type folder|shortcut|other\` in semantic
                               mode returns no hits — pair with \`--mode name\`.
  --classification <VAL>       Filter by classification
  --scope <FOLDER_ID>          Restrict to descendants of a folder
  --limit <N>                  Max hits (default 20)
  --threshold <X>              Minimum cosine similarity (semantic only)
  --embedding-provider <NAME>  Embedding provider: openai | azure-openai | voyage | ollama
  --json                       Emit JSON envelope

Environment:
  OPENAI_API_KEY                  Required for semantic search with openai
  AZURE_OPENAI_API_KEY            Required for semantic search with azure-openai
  AZURE_OPENAI_ENDPOINT           Required for semantic search with azure-openai
  VOYAGE_API_KEY                  Required for semantic search with voyage
  GDRIVESCOPE_EMBEDDING_PROVIDER  Default embedding provider (auto-inferred if not set)
`;

function parseThreshold(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new CliError(`invalid --threshold value: ${value}`, 'USAGE');
  }
  return n;
}

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

export async function run(
  flags: SearchFlags
): Promise<ApiResponse<SearchData>> {
  if (!flags._positional) {
    return toResponse(
      new CliError('Usage: gdrivescope search <QUERY>', 'MISSING_ARG')
    );
  }
  const positional = flags._positional;
  try {
    const type = parseTypeFilter(flags.type);
    return await withStoreAsync(getDbPath(), async (store) => {
      const hasEmbeddings = store.hasVectorTable();
      const mode: SearchMode =
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
          configModel: cfg.embedding?.model,
          embeddingConfig: cfg.embedding,
          ollamaConfig: cfg.ollama,
          azureConfig: cfg.azure,
        });
        const graph = hydrateGraph(store);
        const hits = await semanticSearch({
          query: positional,
          provider,
          store,
          graph,
          limit,
          threshold: parseThreshold(flags.threshold),
          scope: flags.scope,
          classification: flags.classification,
        });
        return success({
          query: positional,
          mode,
          type,
          hits: hits
            .filter((h) =>
              type ? classifyNodeType(h.mimeType) === type : true
            )
            .map((h) => ({
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
      const query = positional.toLowerCase();
      const graph = hydrateGraph(store);
      const scopeSet = flags.scope ? descendants(graph, flags.scope) : null;

      const rows = store.searchByName(query, flags.classification ?? undefined);

      const hits: SearchHit[] = rows
        .map((r) => ({
          id: r.id,
          name: r.name,
          mimeType: r.mimeType,
          path: nodePath(graph, r.id),
          score: null as number | null,
          classification: r.classification,
        }))
        .filter((h) => (scopeSet ? scopeSet.has(h.id) : true))
        .filter((h) => (type ? classifyNodeType(h.mimeType) === type : true))
        .sort((a, b) => {
          const aExact = a.name.toLowerCase() === query;
          const bExact = b.name.toLowerCase() === query;
          if (aExact !== bExact) return aExact ? -1 : 1;
          if (a.name.length !== b.name.length)
            return a.name.length - b.name.length;
          return a.name.localeCompare(b.name);
        })
        .slice(0, limit);

      return success({ query: positional, mode: 'name', type, hits });
    });
  } catch (err) {
    return toResponse(err);
  }
}

export function render(data: SearchData): string {
  const filterSuffix = data.type ? `, type=${data.type}` : '';
  if (data.hits.length === 0) {
    return `No matches for "${data.query}" (${data.mode} mode${filterSuffix}).`;
  }
  const header = `${data.hits.length} hit(s) for "${data.query}" (${data.mode} mode${filterSuffix}):`;
  const rows = data.hits.map((h) => {
    const score = h.score !== null ? `  [${h.score.toFixed(3)}]` : '';
    return `  ${h.path}  (${h.mimeType})${score}`;
  });
  return [header, ...rows].join('\n');
}

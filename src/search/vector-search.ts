import type { DriveGraph } from '../graph/model.js';
import { descendants, nodePath } from '../graph/paths.js';
import type { Store } from '../graph/store.js';
import type { EmbeddingProvider } from '../llm/embedding-provider.js';
import { CliError } from '../utils/errors.js';

export interface Hit {
  id: string;
  name: string;
  mimeType: string;
  path: string;
  score: number;
  classification: string | null;
}

export interface SemanticSearchOptions {
  query: string;
  provider: EmbeddingProvider;
  store: Store;
  graph: DriveGraph;
  limit?: number;
  threshold?: number;
  scope?: string;
  classification?: string;
}

interface KnnRow {
  id: string;
  distance: number;
}

export async function semanticSearch(
  opts: SemanticSearchOptions
): Promise<Hit[]> {
  const limit = Math.max(opts.limit ?? 20, 1);
  const threshold = opts.threshold ?? 0;

  if (opts.store.getMeta('embedding_dims') === null) {
    throw new CliError(
      'No embeddings found. Run `gdrivescope index --scope X` first.',
      'NO_EMBEDDINGS'
    );
  }

  const [queryVec] = await opts.provider.embed([opts.query]);
  if (!queryVec) {
    throw new CliError(
      'Embedding provider returned no vectors for query.',
      'EMBED_CALL_FAILED'
    );
  }
  const queryBuf = new Uint8Array(new Float32Array(queryVec).buffer);

  // Over-fetch so post-filters (scope, classification, threshold) still
  // leave room to hit `limit`.
  const kOverSample = limit * 3;

  const rows = opts.store.db
    .prepare(
      `SELECT node_id AS id, distance
         FROM embeddings
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`
    )
    .all(queryBuf, kOverSample) as KnnRow[];

  const scopeSet = opts.scope ? descendants(opts.graph, opts.scope) : null;
  const hits: Hit[] = [];
  for (const row of rows) {
    const node = opts.store.getNode(row.id);
    if (!node) continue;
    if (scopeSet && !scopeSet.has(node.id)) continue;
    if (opts.classification && node.classification !== opts.classification) {
      continue;
    }
    const score = 1 - row.distance;
    if (score < threshold) continue;
    hits.push({
      id: node.id,
      name: node.name,
      mimeType: node.mimeType,
      path: nodePath(opts.graph, node.id),
      score,
      classification: node.classification,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

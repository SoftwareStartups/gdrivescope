import type { DriveGraph } from '../graph/model.js';
import { descendants } from '../graph/paths.js';

export interface PruneSetInput {
  graph: DriveGraph;
  seenIds: ReadonlySet<string>;
  /** Scope anchor for pruning. `null` prunes the entire graph. */
  scopeId: string | null;
}

export function computePruneSet(input: PruneSetInput): string[] {
  const { graph, seenIds, scopeId } = input;
  const candidates: Iterable<string> =
    scopeId == null ? graph.nodes() : descendants(graph, scopeId);
  const out: string[] = [];
  for (const id of candidates) {
    if (!seenIds.has(id)) out.push(id);
  }
  return out;
}

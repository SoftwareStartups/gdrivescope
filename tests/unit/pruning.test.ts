import { describe, expect, test } from 'bun:test';
import { DirectedGraph } from 'graphology';
import type { DriveGraph, EdgeAttrs, Node } from '../../src/graph/model.js';
import { computePruneSet } from '../../src/pipeline/pruning.js';

function makeNode(id: string, parentId: string | null): Node {
  return {
    id,
    parentId,
    name: id,
    mimeType:
      parentId == null
        ? 'application/vnd.google-apps.folder'
        : 'application/pdf',
    rootId: null,
    metadataJson: '{}',
    summary: null,
    classification: null,
    keyTopics: null,
    extractedMd: null,
    contentHash: null,
    lastIndexed: null,
    lastError: null,
  };
}

function seedGraph(): DriveGraph {
  const g: DriveGraph = new DirectedGraph<Node, EdgeAttrs>();
  g.addNode('root', makeNode('root', null));
  for (const id of ['A', 'B', 'C', 'D']) {
    g.addNode(id, makeNode(id, 'root'));
    g.addEdge('root', id, {} as EdgeAttrs);
  }
  return g;
}

describe('computePruneSet', () => {
  test('prunes full graph when scopeId is null', () => {
    const graph = seedGraph();
    const result = computePruneSet({
      graph,
      seenIds: new Set(['root', 'A', 'B']),
      scopeId: null,
    });
    expect(result.sort()).toEqual(['C', 'D']);
  });

  test('prunes descendants of scope only', () => {
    const graph = seedGraph();
    const result = computePruneSet({
      graph,
      seenIds: new Set(['root', 'A', 'B']),
      scopeId: 'root',
    });
    expect(result.sort()).toEqual(['C', 'D']);
  });

  test('scope with no descendants returns empty', () => {
    const graph = seedGraph();
    const result = computePruneSet({
      graph,
      seenIds: new Set(['A']),
      scopeId: 'A',
    });
    expect(result).toEqual([]);
  });

  test('empty seenIds returns all nodes', () => {
    const graph = seedGraph();
    const result = computePruneSet({
      graph,
      seenIds: new Set(),
      scopeId: null,
    });
    expect(result.sort()).toEqual(['A', 'B', 'C', 'D', 'root']);
  });
});

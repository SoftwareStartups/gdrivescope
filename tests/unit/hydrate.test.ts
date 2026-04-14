import { describe, expect, test } from 'bun:test';
import { hydrateGraph } from '../../src/graph/hydrate.js';
import { nodeInput, seedStore } from '../helpers/makeStore.js';

describe('hydrateGraph', () => {
  test('builds a directed graph from stored nodes', () => {
    const store = seedStore([
      nodeInput({ id: 'r', name: 'Root' }),
      nodeInput({ id: 'f1', parentId: 'r', name: 'f1' }),
      nodeInput({ id: 'f2', parentId: 'r', name: 'f2' }),
      nodeInput({
        id: 'a',
        parentId: 'f1',
        name: 'a',
        mimeType: 'text/plain',
      }),
      nodeInput({
        id: 'b',
        parentId: 'f1',
        name: 'b',
        mimeType: 'text/plain',
      }),
    ]);
    try {
      const graph = hydrateGraph(store);
      expect(graph.order).toBe(5);
      expect(graph.size).toBe(4);
      expect(graph.hasEdge('r', 'f1')).toBe(true);
      expect(graph.hasEdge('r', 'f2')).toBe(true);
      expect(graph.hasEdge('f1', 'a')).toBe(true);
      expect(graph.hasEdge('f1', 'b')).toBe(true);

      const attrs = graph.getNodeAttributes('a');
      expect(attrs.name).toBe('a');
      expect(attrs.mimeType).toBe('text/plain');
      expect(attrs.parentId).toBe('f1');
    } finally {
      store.close();
    }
  });

  test('skips edges whose parent is not in the store', () => {
    const store = seedStore([
      nodeInput({ id: 'orphan', parentId: 'missing', name: 'orphan' }),
    ]);
    try {
      const graph = hydrateGraph(store);
      expect(graph.order).toBe(1);
      expect(graph.size).toBe(0);
    } finally {
      store.close();
    }
  });
});

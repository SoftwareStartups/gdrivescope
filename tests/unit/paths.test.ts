import { describe, expect, test } from 'bun:test';
import { hydrateGraph } from '../../src/graph/hydrate.js';
import { descendants, nodePath } from '../../src/graph/paths.js';
import { nodeInput, seedStore } from '../helpers/makeStore.js';

function tree() {
  return seedStore([
    nodeInput({ id: 'root', name: 'My Drive', parentId: null }),
    nodeInput({ id: 'docs', name: 'Docs', parentId: 'root' }),
    nodeInput({
      id: 'report',
      name: 'report.pdf',
      parentId: 'docs',
      mimeType: 'application/pdf',
    }),
    nodeInput({
      id: 'orphan-child',
      name: 'stray.pdf',
      parentId: 'missing-parent',
      mimeType: 'application/pdf',
    }),
  ]);
}

describe('nodePath', () => {
  test('builds full path from root to leaf', () => {
    const store = tree();
    try {
      const graph = hydrateGraph(store);
      expect(nodePath(graph, 'report')).toBe('My Drive/Docs/report.pdf');
    } finally {
      store.close();
    }
  });

  test('returns <orphan>/id for a node not in the graph', () => {
    const store = tree();
    try {
      const graph = hydrateGraph(store);
      expect(nodePath(graph, 'nope')).toBe('<orphan>/nope');
    } finally {
      store.close();
    }
  });

  test('prefixes <orphan>/ when parent id is missing from the graph', () => {
    const store = tree();
    try {
      const graph = hydrateGraph(store);
      expect(nodePath(graph, 'orphan-child')).toBe('<orphan>/stray.pdf');
    } finally {
      store.close();
    }
  });
});

describe('descendants', () => {
  test('recursive set excludes the root id', () => {
    const store = seedStore([
      nodeInput({ id: 'root', name: 'Root', parentId: null }),
      nodeInput({ id: 'a', name: 'A', parentId: 'root' }),
      nodeInput({ id: 'b', name: 'B', parentId: 'a' }),
      nodeInput({ id: 'c', name: 'C', parentId: 'root' }),
    ]);
    try {
      const graph = hydrateGraph(store);
      const ids = [...descendants(graph, 'root')].sort();
      expect(ids).toEqual(['a', 'b', 'c']);
    } finally {
      store.close();
    }
  });

  test('leaf node has no descendants', () => {
    const store = seedStore([
      nodeInput({ id: 'root', name: 'Root', parentId: null }),
      nodeInput({ id: 'only', name: 'Only', parentId: 'root' }),
    ]);
    try {
      const graph = hydrateGraph(store);
      expect(descendants(graph, 'only').size).toBe(0);
    } finally {
      store.close();
    }
  });

  test('missing root returns empty set', () => {
    const store = seedStore([
      nodeInput({ id: 'root', name: 'Root', parentId: null }),
    ]);
    try {
      const graph = hydrateGraph(store);
      expect(descendants(graph, 'ghost').size).toBe(0);
    } finally {
      store.close();
    }
  });
});

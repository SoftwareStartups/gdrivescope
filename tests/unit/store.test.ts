import { describe, expect, test } from 'bun:test';
import type { DriveNodeInput } from '../../src/graph/model.js';
import { openStore } from '../../src/graph/store.js';
import { CliError } from '../../src/utils/errors.js';

function makeNode(
  overrides: Partial<DriveNodeInput> & Pick<DriveNodeInput, 'id'>
): DriveNodeInput {
  return {
    parentId: null,
    name: overrides.id,
    mimeType: 'application/vnd.google-apps.folder',
    metadata: {},
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('openStore', () => {
  test('stamps schema_version on first open', () => {
    const store = openStore(':memory:');
    try {
      expect(store.getMeta('schema_version')).toBe('3');
    } finally {
      store.close();
    }
  });

  test('upsertNode inserts then updates same id', async () => {
    const store = openStore(':memory:');
    try {
      store.upsertNode(makeNode({ id: 'a', name: 'One', metadata: { v: 1 } }));
      const first = store.getNode('a');
      expect(first?.name).toBe('One');
      expect(JSON.parse(first?.metadataJson ?? '{}')).toEqual({ v: 1 });
      const firstIndexed = first?.lastIndexed ?? '';

      await sleep(5);

      store.upsertNode(makeNode({ id: 'a', name: 'Two', metadata: { v: 2 } }));
      const second = store.getNode('a');
      expect(second?.name).toBe('Two');
      expect(JSON.parse(second?.metadataJson ?? '{}')).toEqual({ v: 2 });
      expect(store.nodeCount()).toBe(1);
      // lastIndexed should not go backwards; usually strictly later.
      expect((second?.lastIndexed ?? '') >= firstIndexed).toBe(true);
    } finally {
      store.close();
    }
  });

  test('listChildren returns alphabetical order', () => {
    const store = openStore(':memory:');
    try {
      store.upsertNode(makeNode({ id: 'root', name: 'root' }));
      store.upsertNode(
        makeNode({
          id: 'c2',
          parentId: 'root',
          name: 'zebra',
          mimeType: 'text/plain',
        })
      );
      store.upsertNode(
        makeNode({
          id: 'c1',
          parentId: 'root',
          name: 'apple',
          mimeType: 'text/plain',
        })
      );
      const children = store.listChildren('root');
      expect(children.map((c) => c.name)).toEqual(['apple', 'zebra']);
    } finally {
      store.close();
    }
  });

  test('listChildren(null) returns top-level nodes only', () => {
    const store = openStore(':memory:');
    try {
      store.upsertNode(makeNode({ id: 'root', name: 'root' }));
      store.upsertNode(
        makeNode({ id: 'child', parentId: 'root', name: 'child' })
      );
      const tops = store.listChildren(null);
      expect(tops.map((n) => n.id)).toEqual(['root']);
    } finally {
      store.close();
    }
  });

  test('setMeta / getMeta round trip', () => {
    const store = openStore(':memory:');
    try {
      store.setMeta('foo', 'bar');
      expect(store.getMeta('foo')).toBe('bar');
      store.setMeta('foo', 'baz');
      expect(store.getMeta('foo')).toBe('baz');
      expect(store.getMeta('missing')).toBeNull();
    } finally {
      store.close();
    }
  });

  test('initVectorTable rejects non-integer dimensions', () => {
    const store = openStore(':memory:');
    try {
      expect(() => store.initVectorTable(1.5)).toThrow(CliError);
    } finally {
      store.close();
    }
  });

  test('initVectorTable rejects zero and negative dimensions', () => {
    const store = openStore(':memory:');
    try {
      expect(() => store.initVectorTable(0)).toThrow(CliError);
      expect(() => store.initVectorTable(-1)).toThrow(CliError);
    } finally {
      store.close();
    }
  });

  test('initVectorTable rejects dimensions exceeding 65536', () => {
    const store = openStore(':memory:');
    try {
      expect(() => store.initVectorTable(100000)).toThrow(CliError);
    } finally {
      store.close();
    }
  });
});

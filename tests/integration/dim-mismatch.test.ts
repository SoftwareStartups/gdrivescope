import { describe, expect, test } from 'bun:test';
import { openStore } from '../../src/graph/store.js';
import { CliError } from '../../src/utils/errors.js';

describe('store.initVectorTable dimension handling', () => {
  function makeVec(dims: number, seed: number): Float32Array {
    const vec = new Float32Array(dims);
    vec[seed % dims] = 1;
    return vec;
  }

  test('same dimension is a no-op', () => {
    const store = openStore(':memory:');
    try {
      store.initVectorTable(8);
      expect(store.hasVectorTable()).toBe(true);
      expect(store.getMeta('embedding_dims')).toBe('8');
      // Calling again with the same dims must not throw and must not drop data.
      store.upsertEmbedding('a', makeVec(8, 0));
      store.initVectorTable(8);
      const row = store.db
        .prepare('SELECT COUNT(*) AS c FROM embeddings')
        .get() as { c: number };
      expect(row.c).toBe(1);
    } finally {
      store.close();
    }
  });

  test('switching dimensions throws EMBEDDING_DIM_MISMATCH', () => {
    const store = openStore(':memory:');
    try {
      store.initVectorTable(1536);
      store.upsertEmbedding('a', makeVec(1536, 0));
      let caught: unknown;
      try {
        store.initVectorTable(512);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(CliError);
      expect((caught as CliError).code).toBe('EMBEDDING_DIM_MISMATCH');
      // Old vectors still there.
      const row = store.db
        .prepare('SELECT COUNT(*) AS c FROM embeddings')
        .get() as { c: number };
      expect(row.c).toBe(1);
      expect(store.getMeta('embedding_dims')).toBe('1536');
    } finally {
      store.close();
    }
  });

  test('rebuild drops old vectors and re-creates at new dimension', () => {
    const store = openStore(':memory:');
    try {
      store.initVectorTable(1536);
      store.upsertEmbedding('a', makeVec(1536, 0));
      store.upsertEmbedding('b', makeVec(1536, 1));

      store.initVectorTable(512, { rebuild: true });
      expect(store.getMeta('embedding_dims')).toBe('512');

      const row = store.db
        .prepare('SELECT COUNT(*) AS c FROM embeddings')
        .get() as { c: number };
      expect(row.c).toBe(0);

      // Can upsert at the new dimension without complaint.
      store.upsertEmbedding('c', makeVec(512, 2));
      const after = store.db
        .prepare('SELECT COUNT(*) AS c FROM embeddings')
        .get() as { c: number };
      expect(after.c).toBe(1);
    } finally {
      store.close();
    }
  });

  test('clearEmbeddings wipes table and meta', () => {
    const store = openStore(':memory:');
    try {
      store.initVectorTable(8);
      store.upsertEmbedding('a', makeVec(8, 0));
      store.clearEmbeddings();
      expect(store.hasVectorTable()).toBe(false);
      expect(store.getMeta('embedding_dims')).toBeNull();

      // Re-initialising at a different dimension now succeeds.
      store.initVectorTable(16);
      expect(store.getMeta('embedding_dims')).toBe('16');
    } finally {
      store.close();
    }
  });
});

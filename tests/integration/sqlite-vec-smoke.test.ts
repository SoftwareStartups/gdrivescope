import { describe, expect, test } from 'bun:test';
import { openStore } from '../../src/graph/store.js';

// Version-drift guard: if sqlite-vec changes its on-disk format or KNN
// semantics between Stage 1 (spike) and Stage 6 (production), this test
// should start failing long before real embeddings do.
describe('sqlite-vec cosine KNN smoke', () => {
  test('MATCH+k query returns nearest neighbors under cosine distance', () => {
    const store = openStore(':memory:');
    try {
      store.db.exec(
        'CREATE VIRTUAL TABLE probe USING vec0(id INTEGER PRIMARY KEY, v FLOAT[4] distance_metric=cosine)'
      );
      const insert = store.db.prepare('INSERT INTO probe(id, v) VALUES (?, ?)');
      const vectors: Array<[number, number[]]> = [
        // Unit-ish vectors along distinct axes so cosine ordering is
        // unambiguous.
        [1, [1, 0, 0, 0]],
        [2, [0, 1, 0, 0]],
        [3, [0.9, 0.1, 0, 0]],
      ];
      for (const [id, vec] of vectors) {
        insert.run(
          id,
          new Uint8Array(new Float32Array(vec).buffer) as unknown as Uint8Array
        );
      }

      const query = new Float32Array([1, 0, 0, 0]);
      const rows = store.db
        .prepare(
          'SELECT id, distance FROM probe WHERE v MATCH ? AND k = ? ORDER BY distance'
        )
        .all(
          new Uint8Array(query.buffer) as unknown as Uint8Array,
          3
        ) as Array<{ id: number; distance: number }>;

      expect(rows).toHaveLength(3);
      // Nearest: id=1 (identical), then id=3 (close), then id=2 (orthogonal).
      expect(rows[0]?.id).toBe(1);
      expect(rows[1]?.id).toBe(3);
      expect(rows[2]?.id).toBe(2);
      // Cosine distance of identical vectors is ~0.
      expect(rows[0]?.distance).toBeLessThan(1e-5);
      // Orthogonal vectors have cosine distance 1.
      expect(rows[2]?.distance).toBeGreaterThan(0.99);
      expect(rows[2]?.distance).toBeLessThan(1.01);
    } finally {
      store.close();
    }
  });
});

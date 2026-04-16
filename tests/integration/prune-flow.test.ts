import { describe, expect, test } from 'bun:test';
import type { drive_v3 } from '@googleapis/drive';
import { openStore } from '../../src/graph/store.js';
import { runIndexPipeline } from '../../src/pipeline/index-pipeline.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
}

function makeClient(visibleIds: readonly string[]): drive_v3.Drive {
  const root: FakeFile = {
    id: 'root',
    name: 'root',
    mimeType: FOLDER_MIME,
    parents: [],
  };
  const byId: Record<string, FakeFile> = { root };
  const docs: FakeFile[] = [];
  for (const id of visibleIds) {
    const file: FakeFile = {
      id,
      name: id,
      mimeType: DOC_MIME,
      parents: ['root'],
    };
    byId[id] = file;
    docs.push(file);
  }
  const files = {
    get(params: { fileId: string }) {
      const file = byId[params.fileId];
      if (!file) throw new Error(`fake: no file ${params.fileId}`);
      return Promise.resolve({ data: file });
    },
    list(params: { q: string }) {
      const m = params.q.match(/^'([^']+)' in parents/);
      const parent = m?.[1] ?? '';
      return Promise.resolve({
        data: { files: parent === 'root' ? docs : [] },
      });
    },
  };
  return { files } as unknown as drive_v3.Drive;
}

function countNodes(store: ReturnType<typeof openStore>): number {
  const row = store.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as {
    c: number;
  };
  return row.c;
}

function seedNodes(
  store: ReturnType<typeof openStore>,
  ids: readonly string[]
): void {
  for (const id of ids) {
    store.upsertNode({
      id,
      parentId: 'root',
      name: id,
      mimeType: DOC_MIME,
      rootId: 'root',
      metadata: {},
    });
  }
  store.upsertNode({
    id: 'root',
    parentId: null,
    name: 'root',
    mimeType: FOLDER_MIME,
    rootId: null,
    metadata: {},
  });
}

describe('runIndexPipeline — prune', () => {
  const ALL_IDS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10'];
  const VISIBLE_IDS = ALL_IDS.slice(0, 8);

  test('prune removes vanished nodes + embeddings; default leaves them', async () => {
    const store = openStore(':memory:');
    seedNodes(store, ALL_IDS);
    // Seed embeddings for all 10 nodes.
    store.initVectorTable(4);
    for (const id of ALL_IDS) {
      store.upsertEmbedding(id, new Float32Array([0.1, 0.2, 0.3, 0.4]));
    }
    expect(countNodes(store)).toBe(11); // 10 + root

    // Run traversal-only against a drive that only reveals 8 of them,
    // with --prune.
    await runIndexPipeline({
      store,
      client: makeClient(VISIBLE_IDS),
      rootId: 'root',
      metadataOnly: true,
      llm: null,
      prune: true,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });

    expect(countNodes(store)).toBe(9); // 8 + root
    for (const id of ['d9', 'd10']) {
      expect(store.getNode(id)).toBeNull();
    }
    const embeddingCount = store.db
      .prepare('SELECT COUNT(*) AS c FROM embeddings')
      .get() as { c: number };
    expect(embeddingCount.c).toBe(8);
    store.close();
  });

  test('prune: false leaves vanished rows intact', async () => {
    const store = openStore(':memory:');
    seedNodes(store, ALL_IDS);
    expect(countNodes(store)).toBe(11);

    await runIndexPipeline({
      store,
      client: makeClient(VISIBLE_IDS),
      rootId: 'root',
      metadataOnly: true,
      llm: null,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });

    expect(countNodes(store)).toBe(11);
    expect(store.getNode('d9')).not.toBeNull();
    store.close();
  });
});

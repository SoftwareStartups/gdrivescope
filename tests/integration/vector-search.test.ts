import { describe, expect, test } from 'bun:test';
import { hydrateGraph } from '../../src/graph/hydrate.js';
import { openStore, type Store } from '../../src/graph/store.js';
import { semanticSearch } from '../../src/search/vector-search.js';
import { FakeEmbeddingProvider } from '../helpers/fakeEmbedding.js';

interface Seed {
  id: string;
  parentId: string | null;
  name: string;
  mimeType: string;
  text: string;
  classification?: string;
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/pdf';

const SEEDS: Seed[] = [
  { id: 'root', parentId: null, name: 'root', mimeType: FOLDER_MIME, text: '' },
  {
    id: 'strategy',
    parentId: 'root',
    name: 'strategy',
    mimeType: FOLDER_MIME,
    text: '',
  },
  {
    id: 'finance',
    parentId: 'root',
    name: 'finance',
    mimeType: FOLDER_MIME,
    text: '',
  },
  {
    id: 'marketing',
    parentId: 'strategy',
    name: 'marketing-strategy.pdf',
    mimeType: DOC_MIME,
    text: 'marketing strategy for Q3 launch',
    classification: 'strategy',
  },
  {
    id: 'roadmap',
    parentId: 'strategy',
    name: 'roadmap.pdf',
    mimeType: DOC_MIME,
    text: 'product roadmap for next quarter',
    classification: 'strategy',
  },
  {
    id: 'budget',
    parentId: 'finance',
    name: 'budget.pdf',
    mimeType: DOC_MIME,
    text: 'annual budget spreadsheet and cash flow',
    classification: 'finance',
  },
  {
    id: 'invoice',
    parentId: 'finance',
    name: 'invoice-q3.pdf',
    mimeType: DOC_MIME,
    text: 'invoice template and payment records',
    classification: 'finance',
  },
];

async function seedStore(): Promise<Store> {
  const store = openStore(':memory:');
  for (const s of SEEDS) {
    store.upsertNode({
      id: s.id,
      parentId: s.parentId,
      name: s.name,
      mimeType: s.mimeType,
      metadata: {},
    });
    if (s.text) {
      store.updateSummary(s.id, {
        summary: s.text,
        classification: s.classification ?? 'other',
        keyTopics: JSON.stringify([]),
        extractedMd: s.text,
        contentHash: `hash-${s.id}`,
      });
    }
  }

  const provider = new FakeEmbeddingProvider(16);
  store.initVectorTable(provider.dimensions);
  const docs = SEEDS.filter((s) => s.text);
  const vectors = await provider.embed(docs.map((d) => d.text));
  for (let i = 0; i < docs.length; i += 1) {
    const seed = docs[i];
    const vec = vectors[i];
    if (!seed || !vec) continue;
    store.upsertEmbedding(seed.id, new Float32Array(vec));
  }
  return store;
}

describe('semanticSearch', () => {
  test('ranks the matching document first', async () => {
    const store = await seedStore();
    try {
      const graph = hydrateGraph(store);
      const hits = await semanticSearch({
        query: 'marketing strategy for Q3 launch',
        provider: new FakeEmbeddingProvider(16),
        store,
        graph,
        limit: 5,
      });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.id).toBe('marketing');
      expect(hits[0]?.score).toBeGreaterThan(0.9);
      expect(hits[0]?.path).toBe('root/strategy/marketing-strategy.pdf');
    } finally {
      store.close();
    }
  });

  test('threshold cuts low-score hits', async () => {
    const store = await seedStore();
    try {
      const graph = hydrateGraph(store);
      const hits = await semanticSearch({
        query: 'marketing strategy for Q3 launch',
        provider: new FakeEmbeddingProvider(16),
        store,
        graph,
        limit: 10,
        threshold: 0.99,
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.id).toBe('marketing');
    } finally {
      store.close();
    }
  });

  test('scope restricts hits to descendants of a folder', async () => {
    const store = await seedStore();
    try {
      const graph = hydrateGraph(store);
      const hits = await semanticSearch({
        query: 'budget invoice',
        provider: new FakeEmbeddingProvider(16),
        store,
        graph,
        limit: 10,
        scope: 'finance',
      });
      expect(hits.length).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(['budget', 'invoice']).toContain(hit.id);
      }
    } finally {
      store.close();
    }
  });

  test('classification filter keeps only matching nodes', async () => {
    const store = await seedStore();
    try {
      const graph = hydrateGraph(store);
      const hits = await semanticSearch({
        query: 'budget invoice',
        provider: new FakeEmbeddingProvider(16),
        store,
        graph,
        limit: 10,
        classification: 'finance',
      });
      for (const hit of hits) {
        expect(hit.classification).toBe('finance');
      }
    } finally {
      store.close();
    }
  });

  test('throws NO_EMBEDDINGS when vector table is empty', async () => {
    const store = openStore(':memory:');
    try {
      const graph = hydrateGraph(store);
      let caught: unknown;
      try {
        await semanticSearch({
          query: 'anything',
          provider: new FakeEmbeddingProvider(16),
          store,
          graph,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect((caught as { code: string }).code).toBe('NO_EMBEDDINGS');
    } finally {
      store.close();
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { run } from '../../src/cli/commands/file-search.js';
import { openStore } from '../../src/graph/store.js';
import { FakeEmbeddingProvider } from '../helpers/fakeEmbedding.js';
import { nodeInput } from '../helpers/makeStore.js';
import {
  type TempDbContext,
  seedTempDb,
  useTempDb,
} from '../helpers/tempDb.js';

describe('file search command', () => {
  let ctx: TempDbContext;

  beforeEach(() => {
    ctx = useTempDb('filesearch');
    seedTempDb(ctx.dbPath, [
      nodeInput({ id: 'root', name: 'My Drive', parentId: null }),
      nodeInput({ id: 'docs', name: 'Docs', parentId: 'root' }),
      nodeInput({ id: 'other', name: 'Other', parentId: 'root' }),
      nodeInput({
        id: 'r1',
        name: 'report.pdf',
        parentId: 'docs',
        mimeType: 'application/pdf',
      }),
      nodeInput({
        id: 'r2',
        name: 'report-final.pdf',
        parentId: 'docs',
        mimeType: 'application/pdf',
      }),
      nodeInput({
        id: 'n1',
        name: 'notes.md',
        parentId: 'docs',
        mimeType: 'text/markdown',
      }),
      nodeInput({
        id: 'r3',
        name: 'strategy-report.pdf',
        parentId: 'other',
        mimeType: 'application/pdf',
      }),
    ]);
  });

  afterEach(() => ctx.cleanup());

  test('keyword match, sorted exact-first then by name length', async () => {
    const response = await run({ _positional: 'report' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const ids = response.data.hits.map((h) => h.id);
    // No exact match for "report" alone — all three candidates match on
    // substring. Shortest name wins: "report.pdf" (10) before
    // "report-final.pdf" (16) before "strategy-report.pdf" (19).
    expect(ids).toEqual(['r1', 'r2', 'r3']);
    expect(response.data.hits[0]?.score).toBeNull();
  });

  test('missing positional → MISSING_ARG', async () => {
    const response = await run({});
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.code).toBe('MISSING_ARG');
  });

  test('--mode semantic without embeddings → NO_EMBEDDINGS', async () => {
    const response = await run({ _positional: 'report', mode: 'semantic' });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.code).toBe('NO_EMBEDDINGS');
  });

  test('name mode is used automatically when no embeddings exist', async () => {
    const response = await run({ _positional: 'report' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.mode).toBe('name');
  });

  test('auto-dispatches to semantic when embeddings exist', async () => {
    // Seed vectors so hasVectorTable() returns true and the resolver is
    // reached. The resolver will then fail with PROVIDER_UNCONFIGURED
    // because no API key is set — the important assertion here is the
    // *dispatch*, not the outcome.
    const provider = new FakeEmbeddingProvider(8);
    const store = openStore(ctx.dbPath);
    try {
      store.initVectorTable(provider.dimensions);
      const vec = (await provider.embed(['seed']))[0] ?? [];
      store.upsertEmbedding('r1', new Float32Array(vec));
    } finally {
      store.close();
    }

    const savedOpenai = Bun.env.OPENAI_API_KEY;
    const savedProvider = Bun.env.GDRIVESCOPE_EMBEDDING_PROVIDER;
    delete Bun.env.OPENAI_API_KEY;
    delete Bun.env.GDRIVESCOPE_EMBEDDING_PROVIDER;
    try {
      const response = await run({ _positional: 'report' });
      expect(response.ok).toBe(false);
      if (response.ok) return;
      // Dispatch reached the resolver, which threw PROVIDER_UNCONFIGURED.
      expect(response.code).toBe('PROVIDER_UNCONFIGURED');
    } finally {
      if (savedOpenai !== undefined) Bun.env.OPENAI_API_KEY = savedOpenai;
      if (savedProvider !== undefined) {
        Bun.env.GDRIVESCOPE_EMBEDDING_PROVIDER = savedProvider;
      }
    }
  });

  test('--classification yields zero hits when none are set', async () => {
    const response = await run({
      _positional: 'report',
      classification: 'financial',
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.hits).toHaveLength(0);
  });

  test('--scope restricts to descendants of the given folder', async () => {
    const response = await run({ _positional: 'report', scope: 'docs' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const ids = response.data.hits.map((h) => h.id).sort();
    expect(ids).toEqual(['r1', 'r2']);
  });

  test('--limit truncates', async () => {
    const response = await run({ _positional: 'report', limit: '1' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.hits).toHaveLength(1);
    expect(response.data.hits[0]?.id).toBe('r1');
  });
});

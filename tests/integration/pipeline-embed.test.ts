import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { drive_v3 } from '@googleapis/drive';
import { openStore } from '../../src/graph/store.js';
import { runIndexPipeline } from '../../src/pipeline/index-pipeline.js';
import { FakeEmbeddingProvider } from '../helpers/fakeEmbedding.js';
import { FakeLlmProvider } from '../helpers/fakeLlm.js';

const SAMPLE_PDF = readFileSync(
  fileURLToPath(
    new URL('../../scripts/spikes/fixtures/sample.pdf', import.meta.url)
  )
);

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  size?: number;
}

function makeClient(): drive_v3.Drive {
  const root: FakeFile = {
    id: 'root',
    name: 'root',
    mimeType: FOLDER_MIME,
    parents: [],
  };
  const pdf: FakeFile = {
    id: 'pdf1',
    name: 'report.pdf',
    mimeType: 'application/pdf',
    parents: ['root'],
    size: SAMPLE_PDF.length,
  };
  const doc: FakeFile = {
    id: 'doc1',
    name: 'notes',
    mimeType: DOC_MIME,
    parents: ['root'],
  };
  const sheet: FakeFile = {
    id: 'sheet1',
    name: 'budget',
    mimeType: SHEET_MIME,
    parents: ['root'],
  };
  const byId: Record<string, FakeFile> = {
    root,
    pdf1: pdf,
    doc1: doc,
    sheet1: sheet,
  };
  const children: Record<string, FakeFile[]> = {
    root: [pdf, doc, sheet],
  };
  const payloads: Record<string, Buffer> = {
    'get:pdf1': Buffer.from(SAMPLE_PDF),
    'export:doc1:text/plain': Buffer.from('meeting notes with action items'),
    'export:sheet1:text/csv': Buffer.from('month,revenue\n2026-01,42\n'),
  };
  const files = {
    get(params: { fileId: string; alt?: string }) {
      if (params.alt === 'media') {
        const payload = payloads[`get:${params.fileId}`];
        if (!payload) throw new Error(`no payload for ${params.fileId}`);
        return Promise.resolve({ data: Readable.from([payload]) });
      }
      const file = byId[params.fileId];
      if (!file) throw new Error(`no file ${params.fileId}`);
      return Promise.resolve({ data: file });
    },
    list(params: { q: string }) {
      const m = params.q.match(/^'([^']+)' in parents/);
      const parent = m?.[1] ?? '';
      return Promise.resolve({ data: { files: children[parent] ?? [] } });
    },
    export(params: { fileId: string; mimeType: string }) {
      const payload = payloads[`export:${params.fileId}:${params.mimeType}`];
      if (!payload) {
        throw new Error(`no export for ${params.fileId} → ${params.mimeType}`);
      }
      return Promise.resolve({ data: Readable.from([payload]) });
    },
  };
  return { files } as unknown as drive_v3.Drive;
}

describe('runIndexPipeline — embeddings', () => {
  test('embeds summarised nodes and records embedding_dims', async () => {
    const store = openStore(':memory:');
    const llm = new FakeLlmProvider();
    const embedding = new FakeEmbeddingProvider(16);

    const stats = await runIndexPipeline({
      store,
      client: makeClient(),
      rootId: 'root',
      metadataOnly: false,
      llm,
      embedding,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });

    expect(stats.summarized).toBe(3);
    expect(stats.embedded).toBe(3);
    expect(store.getMeta('embedding_dims')).toBe('16');

    const row = store.db
      .prepare('SELECT COUNT(*) AS c FROM embeddings')
      .get() as { c: number };
    expect(row.c).toBe(3);
    expect(embedding.calls).toHaveLength(1);
    expect(embedding.calls[0]).toHaveLength(3);

    store.close();
  });

  test('rebuildEmbeddings drops and recreates the vector table', async () => {
    const store = openStore(':memory:');
    const client = makeClient();
    const llm = new FakeLlmProvider();

    // First pass: 16-dim.
    await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm,
      embedding: new FakeEmbeddingProvider(16),
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });
    expect(store.getMeta('embedding_dims')).toBe('16');

    // Second pass: 8-dim with rebuild — tables must be wiped and rewritten.
    const stats = await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm,
      embedding: new FakeEmbeddingProvider(8),
      rebuildEmbeddings: true,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });

    expect(store.getMeta('embedding_dims')).toBe('8');
    // Content hashes unchanged → no new summaries, but embeddings still ran
    // because the vector table was rebuilt from scratch.
    expect(stats.summarized).toBe(0);
    expect(stats.embedded).toBe(3);

    store.close();
  });

  test('metadata-only skips the embed step entirely', async () => {
    const store = openStore(':memory:');
    const stats = await runIndexPipeline({
      store,
      client: makeClient(),
      rootId: 'root',
      metadataOnly: true,
      llm: new FakeLlmProvider(),
      embedding: new FakeEmbeddingProvider(8),
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });
    expect(stats.embedded).toBe(0);
    expect(store.getMeta('embedding_dims')).toBeNull();
    store.close();
  });
});

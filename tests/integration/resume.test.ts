import { describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import type { drive_v3 } from '@googleapis/drive';
import { openStore } from '../../src/graph/store.js';
import { runIndexPipeline } from '../../src/pipeline/index-pipeline.js';
import { FakeLlmProvider } from '../helpers/fakeLlm.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
const FILE_COUNT = 10;

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
}

function makeClient(): drive_v3.Drive {
  const root: FakeFile = {
    id: 'root',
    name: 'root',
    mimeType: FOLDER_MIME,
    parents: [],
  };
  const byId: Record<string, FakeFile> = { root };
  const docs: FakeFile[] = [];
  const payloads: Record<string, Buffer> = {};
  for (let i = 0; i < FILE_COUNT; i += 1) {
    const id = `doc${i}`;
    const file: FakeFile = {
      id,
      name: `doc-${i}`,
      mimeType: DOC_MIME,
      parents: ['root'],
    };
    byId[id] = file;
    docs.push(file);
    payloads[`export:${id}:text/plain`] = Buffer.from(`body ${i}`);
  }
  const files = {
    get(params: { fileId: string; alt?: string }) {
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
    export(params: { fileId: string; mimeType: string }) {
      const payload = payloads[`export:${params.fileId}:${params.mimeType}`];
      if (!payload) {
        throw new Error(`fake: no export ${params.fileId}`);
      }
      return Promise.resolve({ data: Readable.from([payload]) });
    },
  };
  return { files } as unknown as drive_v3.Drive;
}

describe('runIndexPipeline — resume', () => {
  test('only re-processes nodes with missing summary or set last_error', async () => {
    const store = openStore(':memory:');
    const client = makeClient();

    // First pass: populate everything.
    const firstLlm = new FakeLlmProvider();
    const stats1 = await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm: firstLlm,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });
    expect(stats1.summarized).toBe(FILE_COUNT);
    for (let i = 0; i < FILE_COUNT; i += 1) {
      expect(store.getNode(`doc${i}`)?.lastIndexed).not.toBeNull();
    }

    // Simulate mid-run interruption: 3 nodes never got their summary
    // (wipe summary + hash), 2 nodes crashed inside summarize (last_error
    // set, summary wiped so the hash gate doesn't short-circuit the rerun).
    store.db
      .prepare(
        'UPDATE nodes SET summary = NULL, content_hash = NULL WHERE id IN (?, ?, ?)'
      )
      .run('doc0', 'doc1', 'doc2');
    store.db
      .prepare(
        "UPDATE nodes SET last_error = 'simulated', summary = NULL WHERE id IN (?, ?)"
      )
      .run('doc5', 'doc6');

    // Second pass with resume.
    const resumeLlm = new FakeLlmProvider();
    const stats2 = await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm: resumeLlm,
      resume: true,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });

    expect(resumeLlm.calls.map((c) => c.filename).sort()).toEqual([
      'doc-0',
      'doc-1',
      'doc-2',
      'doc-5',
      'doc-6',
    ]);
    expect(stats2.summarized).toBe(5);

    // last_error is cleared after a successful rerun.
    expect(store.getNode('doc5')?.lastError).toBeNull();
    expect(store.getNode('doc6')?.lastError).toBeNull();
    // Untouched nodes keep their original last_indexed.
    expect(store.getNode('doc9')?.lastIndexed).not.toBeNull();
    store.close();
  });
});

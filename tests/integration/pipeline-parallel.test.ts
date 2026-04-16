import { describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import type { drive_v3 } from '@googleapis/drive';
import { openStore } from '../../src/graph/store.js';
import { runIndexPipeline } from '../../src/pipeline/index-pipeline.js';
import type {
  LlmProvider,
  LlmSummarizeInput,
  LlmSummary,
} from '../../src/llm/provider.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
const FILE_COUNT = 20;

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
}

interface Tree {
  byId: Record<string, FakeFile>;
  children: Record<string, FakeFile[]>;
  payloads: Record<string, Buffer>;
}

function buildDocTree(count: number): Tree {
  const root: FakeFile = {
    id: 'root',
    name: 'root',
    mimeType: FOLDER_MIME,
    parents: [],
  };
  const byId: Record<string, FakeFile> = { root };
  const docs: FakeFile[] = [];
  const payloads: Record<string, Buffer> = {};
  for (let i = 0; i < count; i += 1) {
    const id = `doc${i}`;
    const file: FakeFile = {
      id,
      name: `doc-${i}.txt`,
      mimeType: DOC_MIME,
      parents: ['root'],
    };
    byId[id] = file;
    docs.push(file);
    payloads[`export:${id}:text/plain`] = Buffer.from(`document body ${i}`);
  }
  return { byId, children: { root: docs }, payloads };
}

function makeClient(tree: Tree): drive_v3.Drive {
  const files = {
    get(params: { fileId: string; alt?: string }) {
      const file = tree.byId[params.fileId];
      if (!file) throw new Error(`fake: no file ${params.fileId}`);
      return Promise.resolve({ data: file });
    },
    list(params: { q: string }) {
      const m = params.q.match(/^'([^']+)' in parents/);
      const parent = m?.[1] ?? '';
      return Promise.resolve({
        data: { files: tree.children[parent] ?? [] },
      });
    },
    export(params: { fileId: string; mimeType: string }) {
      const payload =
        tree.payloads[`export:${params.fileId}:${params.mimeType}`];
      if (!payload) {
        throw new Error(`fake: no export ${params.fileId} ${params.mimeType}`);
      }
      return Promise.resolve({ data: Readable.from([payload]) });
    },
  };
  return { files } as unknown as drive_v3.Drive;
}

class TracingLlm implements LlmProvider {
  readonly name = 'trace';
  readonly entries: number[] = [];
  private peak = 0;
  private inFlight = 0;
  private holdMs: number;
  private failIds: Set<string>;

  constructor(holdMs: number, failIds: string[] = []) {
    this.holdMs = holdMs;
    this.failIds = new Set(failIds);
  }

  get maxInFlight(): number {
    return this.peak;
  }

  async summarize(input: LlmSummarizeInput): Promise<LlmSummary> {
    this.entries.push(performance.now());
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      await new Promise((r) => setTimeout(r, this.holdMs));
      if (this.failIds.has(input.filename)) {
        throw new Error(`forced failure for ${input.filename}`);
      }
      return {
        summary: `summary of ${input.filename}`,
        classification: 'other',
        keyTopics: ['trace'],
      };
    } finally {
      this.inFlight -= 1;
    }
  }
}

describe('runIndexPipeline — parallel', () => {
  test('runs summarize in parallel up to llmConcurrency', async () => {
    const store = openStore(':memory:');
    const client = makeClient(buildDocTree(FILE_COUNT));
    const llm = new TracingLlm(30);

    const stats = await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm,
      driveConcurrency: 5,
      llmConcurrency: 2,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });

    expect(stats.summarized).toBe(FILE_COUNT);
    expect(stats.errors).toBe(0);
    // Parallelism actually happened:
    expect(llm.maxInFlight).toBeGreaterThan(1);
    // …but was bounded by the llm semaphore.
    expect(llm.maxInFlight).toBeLessThanOrEqual(2);
    store.close();
  });

  test('per-node failures are isolated and the run continues', async () => {
    const store = openStore(':memory:');
    const client = makeClient(buildDocTree(FILE_COUNT));
    const llm = new TracingLlm(5, ['doc-3.txt', 'doc-7.txt']);

    const stats = await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm,
      driveConcurrency: 4,
      llmConcurrency: 3,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });

    expect(stats.summarized).toBe(FILE_COUNT - 2);
    expect(stats.errors).toBe(2);
    expect(store.getNode('doc3')?.lastError).toContain('forced failure');
    expect(store.getNode('doc7')?.lastError).toContain('forced failure');
    expect(store.getNode('doc0')?.lastError).toBeNull();
    store.close();
  });
});

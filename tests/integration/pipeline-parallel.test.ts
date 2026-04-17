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

interface ExportTracker {
  peakExports: number;
}

function makeClient(
  tree: Tree,
  opts?: { exportHoldMs?: number; tracker?: ExportTracker }
): drive_v3.Drive {
  let inFlightExports = 0;
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
    async export(params: { fileId: string; mimeType: string }) {
      const payload =
        tree.payloads[`export:${params.fileId}:${params.mimeType}`];
      if (!payload) {
        throw new Error(`fake: no export ${params.fileId} ${params.mimeType}`);
      }
      inFlightExports += 1;
      if (opts?.tracker) {
        opts.tracker.peakExports = Math.max(
          opts.tracker.peakExports,
          inFlightExports
        );
      }
      try {
        if (opts?.exportHoldMs) {
          await new Promise((r) => setTimeout(r, opts.exportHoldMs));
        }
        return { data: Readable.from([payload]) };
      } finally {
        inFlightExports -= 1;
      }
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

  test('drive concurrency is independent of llm concurrency', async () => {
    // With drive=5 and llm=1, each task's drive permit must be released
    // before its LLM call blocks, otherwise 5 downloads would have to wait
    // serially on the single LLM slot. We verify peak concurrent downloads
    // exceeds the LLM concurrency.
    const store = openStore(':memory:');
    const tracker: ExportTracker = { peakExports: 0 };
    const client = makeClient(buildDocTree(FILE_COUNT), {
      exportHoldMs: 30,
      tracker,
    });
    const llm = new TracingLlm(100);

    const stats = await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm,
      driveConcurrency: 5,
      llmConcurrency: 1,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });

    expect(stats.summarized).toBe(FILE_COUNT);
    expect(stats.errors).toBe(0);
    // The llm semaphore still throttles summaries to 1.
    expect(llm.maxInFlight).toBe(1);
    // But the drive side saw concurrent downloads well above 1 — it would
    // be capped at 1 if drive permits were held through the LLM call.
    expect(tracker.peakExports).toBeGreaterThan(1);
    expect(tracker.peakExports).toBeLessThanOrEqual(5);
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

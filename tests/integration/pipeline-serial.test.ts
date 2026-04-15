import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { drive_v3 } from '@googleapis/drive';
import { PDFDocument } from 'pdf-lib';
import { openStore } from '../../src/graph/store.js';
import { runIndexPipeline } from '../../src/pipeline/index-pipeline.js';
import { FakeLlmProvider } from '../helpers/fakeLlm.js';

const SAMPLE_PDF_PATH = fileURLToPath(
  new URL('../../scripts/spikes/fixtures/sample.pdf', import.meta.url)
);
const SAMPLE_PDF = readFileSync(SAMPLE_PDF_PATH);

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

interface FakeTree {
  byId: Record<string, FakeFile>;
  children: Record<string, FakeFile[]>;
  payloads: Record<string, Buffer>; // keyed by `get:<id>` or `export:<id>:<mime>`
}

function buildDefaultTree(): FakeTree {
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
  const png: FakeFile = {
    id: 'png1',
    name: 'photo.png',
    mimeType: 'image/png',
    parents: ['root'],
    size: 4,
  };
  return {
    byId: {
      root,
      pdf1: pdf,
      doc1: doc,
      sheet1: sheet,
      png1: png,
    },
    children: {
      root: [pdf, doc, sheet, png],
    },
    payloads: {
      'get:pdf1': Buffer.from(SAMPLE_PDF),
      'export:doc1:text/plain': Buffer.from(
        'These are the meeting notes. Action items follow.'
      ),
      'export:sheet1:text/csv': Buffer.from('month,revenue\n2026-01,42\n'),
    },
  };
}

function makeClient(tree: FakeTree): drive_v3.Drive {
  const files = {
    get(params: { fileId: string; alt?: string }) {
      if (params.alt === 'media') {
        const payload = tree.payloads[`get:${params.fileId}`];
        if (!payload) {
          throw new Error(`fake: no get payload for ${params.fileId}`);
        }
        return Promise.resolve({ data: Readable.from([payload]) });
      }
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
        throw new Error(
          `fake: no export payload for ${params.fileId} → ${params.mimeType}`
        );
      }
      return Promise.resolve({ data: Readable.from([payload]) });
    },
  };
  return { files } as unknown as drive_v3.Drive;
}

describe('runIndexPipeline — serial', () => {
  test('summarizes pdf + doc + sheet; skips png; is idempotent on rerun', async () => {
    const store = openStore(':memory:');
    const tree = buildDefaultTree();
    const client = makeClient(tree);
    const llm = new FakeLlmProvider();

    const stats = await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });

    expect(stats.visited).toBe(5);
    expect(stats.skipped).toBe(2); // folder + png
    expect(stats.summarized).toBe(3); // pdf + doc + sheet
    expect(stats.extracted).toBe(3);
    expect(stats.errors).toBe(0);
    expect(llm.calls).toHaveLength(3);

    // Doc went through the text-export fast path — no kreuzberg artifacts.
    const docRow = store.getNode('doc1');
    expect(docRow?.extractedMd).toContain('meeting notes');
    expect(docRow?.classification).toBe('other');

    // Sheet exported as CSV.
    const sheetRow = store.getNode('sheet1');
    expect(sheetRow?.extractedMd).toContain('month,revenue');

    // Re-run: content_hash gate should short-circuit all three — 0 new calls.
    const stats2 = await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });
    expect(stats2.summarized).toBe(0);
    expect(llm.calls).toHaveLength(3);

    store.close();
  });

  test('per-node failure records last_error and the run completes', async () => {
    const store = openStore(':memory:');
    const tree = buildDefaultTree();
    const client = makeClient(tree);
    const llm = new FakeLlmProvider(() => {
      throw new Error('boom');
    });

    const stats = await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });

    expect(stats.errors).toBe(3);
    expect(stats.summarized).toBe(0);
    expect(store.getNode('pdf1')?.lastError).toContain('boom');
    expect(store.getNode('doc1')?.lastError).toContain('boom');
    expect(store.getNode('sheet1')?.lastError).toContain('boom');
    // PNG stayed skipped (no error).
    expect(store.getNode('png1')?.lastError).toBeNull();

    store.close();
  });

  test('pre-download size gate skips nodes whose metadata size exceeds cap', async () => {
    const store = openStore(':memory:');
    const tree = buildDefaultTree();
    const client = makeClient(tree);
    const llm = new FakeLlmProvider();

    const stats = await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm,
      maxSizeBytes: 1, // everything-with-size is too large
      maxPdfPages: 10,
    });

    // The PDF has size set, so it's size-gated; doc+sheet have no size and
    // still pass through (small text payloads).
    expect(store.getNode('pdf1')?.lastError).toContain('skipped: too large');
    expect(stats.summarized).toBe(2); // doc + sheet
    store.close();
  });

  test('pdf slicing trims a 20-page pdf before kreuzberg', async () => {
    const store = openStore(':memory:');
    const doc = await PDFDocument.create();
    for (let i = 0; i < 20; i++) {
      doc.addPage([200, 200]).drawText(`page ${i + 1}`, {
        x: 20,
        y: 100,
        size: 12,
      });
    }
    const big = await doc.save();

    // Intercept the bytes handed to extract by using a custom downloadToFile? No —
    // easier: inspect extracted_md length indirectly via content_hash stability.
    // Better: stub kreuzberg via module spy. Simpler still: compare hashes of
    // full vs sliced PDF directly using slicePdfToFirstPages, and run pipeline
    // against a tree that serves the big PDF; assert extracted content is
    // derived from the 3-page version.
    const tree: FakeTree = {
      byId: {
        root: { id: 'root', name: 'root', mimeType: FOLDER_MIME, parents: [] },
        big1: {
          id: 'big1',
          name: 'big.pdf',
          mimeType: 'application/pdf',
          parents: ['root'],
          size: big.length,
        },
      },
      children: {
        root: [
          {
            id: 'big1',
            name: 'big.pdf',
            mimeType: 'application/pdf',
            parents: ['root'],
            size: big.length,
          },
        ],
      },
      payloads: {
        'get:big1': Buffer.from(big),
      },
    };
    const client = makeClient(tree);
    const llm = new FakeLlmProvider();

    const stats = await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 3,
    });

    expect(stats.summarized).toBe(1);
    expect(stats.errors).toBe(0);
    const row = store.getNode('big1');
    // Kreuzberg on a 3-page text-only PDF yields text for pages 1–3 only.
    expect(row?.extractedMd).toContain('page 1');
    expect(row?.extractedMd).toContain('page 3');
    expect(row?.extractedMd ?? '').not.toContain('page 10');
    store.close();
  });
});

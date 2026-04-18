import { describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import type { drive_v3 } from '@googleapis/drive';
import {
  isPermanentErrorMessage,
  PERMANENT_ERROR_PREFIX,
} from '../../src/drive/permanent-errors.js';
import { openStore } from '../../src/graph/store.js';
import { runIndexPipeline } from '../../src/pipeline/index-pipeline.js';
import { FakeLlmProvider } from '../helpers/fakeLlm.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
}

interface Counters {
  exportCalls: Record<string, number>;
}

function makeClient(
  unauthorizedId: string,
  counters: Counters
): drive_v3.Drive {
  const root: FakeFile = {
    id: 'root',
    name: 'root',
    mimeType: FOLDER_MIME,
    parents: [],
  };
  const docs: FakeFile[] = [
    { id: 'doc-ok', name: 'doc-ok', mimeType: DOC_MIME, parents: ['root'] },
    {
      id: unauthorizedId,
      name: 'doc-blocked',
      mimeType: DOC_MIME,
      parents: ['root'],
    },
  ];
  const byId: Record<string, FakeFile> = { root };
  for (const d of docs) byId[d.id] = d;

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
      counters.exportCalls[params.fileId] =
        (counters.exportCalls[params.fileId] ?? 0) + 1;
      if (params.fileId === unauthorizedId) {
        const err = new Error(
          `The user has not granted the app 893319340876 read access to the file ${unauthorizedId}.`
        ) as Error & {
          response: {
            data: {
              error: {
                code: number;
                message: string;
                errors: { reason: string; message: string }[];
              };
            };
          };
        };
        err.response = {
          data: {
            error: {
              code: 403,
              message: err.message,
              errors: [
                { reason: 'appNotAuthorizedToFile', message: err.message },
              ],
            },
          },
        };
        throw err;
      }
      const payload = Buffer.from(`body ${params.fileId}`);
      return Promise.resolve({ data: Readable.from([payload]) });
    },
  };
  return { files } as unknown as drive_v3.Drive;
}

describe('runIndexPipeline — appNotAuthorizedToFile', () => {
  test('records permanent marker and --resume skips the blocked node', async () => {
    const store = openStore(':memory:');
    const counters: Counters = { exportCalls: {} };
    const unauthorizedId = 'doc-blocked';
    const client = makeClient(unauthorizedId, counters);

    // First pass: permanent error is classified and stored with marker.
    const llm1 = new FakeLlmProvider();
    const stats1 = await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm: llm1,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });

    expect(stats1.summarized).toBe(1);
    expect(stats1.errors).toBe(1);
    expect(counters.exportCalls[unauthorizedId]).toBe(1);

    const blocked = store.getNode(unauthorizedId);
    expect(blocked).not.toBeNull();
    expect(blocked?.lastError ?? null).not.toBeNull();
    expect(
      blocked?.lastError?.startsWith(
        `${PERMANENT_ERROR_PREFIX}appNotAuthorizedToFile]`
      )
    ).toBe(true);
    expect(isPermanentErrorMessage(blocked?.lastError ?? null)).toBe(true);

    const ok = store.getNode('doc-ok');
    expect(ok?.summary).not.toBeNull();
    expect(ok?.lastError).toBeNull();

    // Second pass with resume: the blocked node must not be re-attempted.
    const llm2 = new FakeLlmProvider();
    const stats2 = await runIndexPipeline({
      store,
      client,
      rootId: 'root',
      metadataOnly: false,
      llm: llm2,
      resume: true,
      maxSizeBytes: 20 * 1024 * 1024,
      maxPdfPages: 10,
    });

    expect(stats2.errors).toBe(0);
    expect(stats2.summarized).toBe(0);
    expect(llm2.calls.length).toBe(0);
    expect(counters.exportCalls[unauthorizedId]).toBe(1);

    store.close();
  });
});

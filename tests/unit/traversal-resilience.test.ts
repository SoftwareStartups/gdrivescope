import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { drive_v3 } from '@googleapis/drive';
import { traverseDriveFolder } from '../../src/drive/traversal.js';
import type { DriveNodeInput } from '../../src/graph/model.js';
import { type FakeTree, makeFakeDrive } from '../helpers/fakeDrive.js';

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';

/**
 * Silence `warn` output during these tests — we only care about counters and
 * returned results. Restored in afterEach.
 */
let stderrWrites: string[] = [];
let originalStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  stderrWrites = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
});

describe('traverseDriveFolder resilience', () => {
  test('shortcut to missing target is skipped, siblings still visited', async () => {
    const tree: FakeTree = {
      root: { id: 'root', name: 'Root', mimeType: FOLDER },
      children: {
        root: [
          {
            id: 'bad-sc',
            name: 'broken-shortcut',
            mimeType: SHORTCUT,
            shortcutDetails: { targetId: 'missing', targetMimeType: FOLDER },
          },
          { id: 'good', name: 'good.md', mimeType: 'text/markdown' },
        ],
      },
      // `missing` intentionally absent from both children and targets.
    };
    const { client } = makeFakeDrive(tree);
    const collected: DriveNodeInput[] = [];

    const result = await traverseDriveFolder(client, {
      rootId: 'root',
      onNode: (n) => {
        collected.push(n);
      },
    });

    // root + good.md. The broken shortcut is not emitted.
    expect(result.visited).toBe(2);
    expect(result.files).toBe(1);
    expect(result.folders).toBe(1);
    expect(result.skippedRefs).toBe(1);
    expect(collected.map((n) => n.id).sort()).toEqual(['good', 'root']);
    expect(
      stderrWrites.some(
        (s) => s.includes('broken-shortcut') && s.includes('missing')
      )
    ).toBe(true);
  });

  test('folder whose listing rejects is skipped, parent still emitted', async () => {
    // Custom fake: root lists fine, but `bad-folder` throws on list. Other
    // siblings of `bad-folder` should still traverse normally.
    const children: Record<string, drive_v3.Schema$File[]> = {
      root: [
        { id: 'bad-folder', name: 'locked', mimeType: FOLDER },
        { id: 'good-folder', name: 'open', mimeType: FOLDER },
      ],
      'good-folder': [
        { id: 'good-doc', name: 'doc.md', mimeType: 'text/markdown' },
      ],
    };
    const filesApi = {
      async get(params: { fileId: string }) {
        if (params.fileId === 'root') {
          return { data: { id: 'root', name: 'Root', mimeType: FOLDER } };
        }
        throw new Error(`no file ${params.fileId}`);
      },
      async list(params: { q: string }) {
        const m = params.q.match(/^'([^']+)' in parents/);
        const parent = m?.[1] ?? '';
        if (parent === 'bad-folder') {
          throw new Error('Drive API: insufficient permissions');
        }
        return { data: { files: children[parent] ?? [] } };
      },
    };
    const client = { files: filesApi } as unknown as drive_v3.Drive;
    const collected: DriveNodeInput[] = [];

    const result = await traverseDriveFolder(client, {
      rootId: 'root',
      onNode: (n) => {
        collected.push(n);
      },
    });

    // root + bad-folder (emitted by parent) + good-folder + good-doc = 4.
    // `bad-folder`'s children are never enumerated.
    expect(result.visited).toBe(4);
    expect(result.folders).toBe(3);
    expect(result.files).toBe(1);
    expect(result.skippedRefs).toBe(1);
    expect(collected.map((n) => n.id).sort()).toEqual([
      'bad-folder',
      'good-doc',
      'good-folder',
      'root',
    ]);
    expect(
      stderrWrites.some(
        (s) =>
          s.includes('bad-folder') && s.includes('insufficient permissions')
      )
    ).toBe(true);
  });

  test('clean tree reports skippedRefs === 0', async () => {
    const tree: FakeTree = {
      root: { id: 'root', name: 'Root', mimeType: FOLDER },
      children: {
        root: [{ id: 'doc', name: 'doc.md', mimeType: 'text/markdown' }],
      },
    };
    const { client } = makeFakeDrive(tree);
    const result = await traverseDriveFolder(client, {
      rootId: 'root',
      onNode: () => {},
    });
    expect(result.skippedRefs).toBe(0);
  });
});

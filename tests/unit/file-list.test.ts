import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli/commands/file-list.js';
import type { DriveNodeInput } from '../../src/graph/model.js';
import { openStore } from '../../src/graph/store.js';
import { nodeInput } from '../helpers/makeStore.js';

function seedDb(dbPath: string, nodes: DriveNodeInput[]): void {
  const store = openStore(dbPath);
  try {
    for (const n of nodes) store.upsertNode(n);
  } finally {
    store.close();
  }
}

describe('file list command', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gdrivescope-filelist-'));
    dbPath = join(tmpDir, 'drive.db');
    Bun.env.GDRIVESCOPE_DB = dbPath;
    seedDb(dbPath, [
      nodeInput({ id: 'root', name: 'My Drive', parentId: null }),
      nodeInput({ id: 'docs', name: 'Docs', parentId: 'root' }),
      nodeInput({ id: 'images', name: 'Images', parentId: 'root' }),
      nodeInput({
        id: 'report',
        name: 'report.pdf',
        parentId: 'docs',
        mimeType: 'application/pdf',
        size: 2048,
      }),
      nodeInput({
        id: 'notes',
        name: 'notes.md',
        parentId: 'docs',
        mimeType: 'text/markdown',
      }),
      nodeInput({
        id: 'logo',
        name: 'logo.png',
        parentId: 'images',
        mimeType: 'image/png',
      }),
    ]);
  });

  afterEach(() => {
    delete Bun.env.GDRIVESCOPE_DB;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('default lists direct children of root', async () => {
    const response = await run({ _positional: 'root' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.files).toHaveLength(2);
    expect(response.data.files.map((f) => f.id).sort()).toEqual([
      'docs',
      'images',
    ]);
    expect(response.data.recursive).toBe(false);
  });

  test('recursive lists all descendants', async () => {
    const response = await run({ _positional: 'root', recursive: true });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.files).toHaveLength(5);
    expect(response.data.recursive).toBe(true);
  });

  test('listing a leaf folder returns its file children with paths', async () => {
    const response = await run({ _positional: 'docs' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const paths = response.data.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'My Drive/Docs/notes.md',
      'My Drive/Docs/report.pdf',
    ]);
    const report = response.data.files.find((f) => f.id === 'report');
    expect(report?.mimeType).toBe('application/pdf');
    expect(report?.size).toBe(2048);
  });

  test('unknown folder id returns NODE_NOT_FOUND', async () => {
    const response = await run({ _positional: 'ghost' });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.code).toBe('NODE_NOT_FOUND');
  });

  test('--limit truncates the result set', async () => {
    const response = await run({
      _positional: 'root',
      recursive: true,
      limit: '3',
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.files).toHaveLength(3);
  });

  test('defaults to FOLDER_ID=root when no positional is supplied', async () => {
    const response = await run({});
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.startId).toBe('root');
    expect(response.data.files.map((f) => f.id).sort()).toEqual([
      'docs',
      'images',
    ]);
  });
});

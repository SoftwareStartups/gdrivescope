import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { run } from '../../src/cli/commands/list.js';
import { nodeInput } from '../helpers/makeStore.js';
import {
  type TempDbContext,
  seedTempDb,
  useTempDb,
} from '../helpers/tempDb.js';

const MY_DRIVE_ID = '0A1B2C3D4myDriveRealId';

describe('list command', () => {
  let ctx: TempDbContext;

  beforeEach(() => {
    ctx = useTempDb('list');
    seedTempDb(ctx.dbPath, [
      nodeInput({ id: MY_DRIVE_ID, name: 'My Drive', parentId: null }),
      nodeInput({ id: 'docs', name: 'Docs', parentId: MY_DRIVE_ID }),
      nodeInput({ id: 'images', name: 'Images', parentId: MY_DRIVE_ID }),
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

  afterEach(() => ctx.cleanup());

  test('defaults to My Drive root when no positional is supplied', async () => {
    const response = await run({});
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.startId).toBe(MY_DRIVE_ID);
    expect(response.data.files.map((f) => f.id).sort()).toEqual([
      'docs',
      'images',
    ]);
    expect(response.data.recursive).toBe(false);
    expect(response.data.type).toBeNull();
  });

  test('`root` sentinel resolves to My Drive root', async () => {
    const response = await run({ _positional: 'root' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.startId).toBe(MY_DRIVE_ID);
    expect(response.data.files.map((f) => f.id).sort()).toEqual([
      'docs',
      'images',
    ]);
  });

  test('`my-drive` sentinel resolves to My Drive root', async () => {
    const response = await run({ _positional: 'my-drive' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.startId).toBe(MY_DRIVE_ID);
  });

  test('recursive lists all descendants', async () => {
    const response = await run({ recursive: true });
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

  test('empty store returns NODE_NOT_FOUND with index suggestion', async () => {
    ctx.cleanup();
    ctx = useTempDb('list-empty');
    seedTempDb(ctx.dbPath, []);
    const response = await run({});
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.code).toBe('NODE_NOT_FOUND');
    expect(response.error).toMatch(/gdrivescope index/);
  });

  test('--limit truncates the result set', async () => {
    const response = await run({
      recursive: true,
      limit: '3',
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.files).toHaveLength(3);
  });

  test('multiple roots: listing with no positional enumerates the roots', async () => {
    ctx.cleanup();
    ctx = useTempDb('list-multi');
    seedTempDb(ctx.dbPath, [
      nodeInput({ id: 'rootA', name: 'Workspace A', parentId: null }),
      nodeInput({ id: 'rootB', name: 'Workspace B', parentId: null }),
      nodeInput({ id: 'childA', name: 'childA', parentId: 'rootA' }),
    ]);
    const response = await run({});
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.startId).toBe('(workspace)');
    expect(response.data.files.map((f) => f.id).sort()).toEqual([
      'rootA',
      'rootB',
    ]);
  });

  test('--type folder returns only folders', async () => {
    const response = await run({ recursive: true, type: 'folder' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.type).toBe('folder');
    expect(response.data.files.map((f) => f.id).sort()).toEqual([
      'docs',
      'images',
    ]);
  });

  test('--type file excludes folders, shortcuts, and media', async () => {
    const response = await run({ recursive: true, type: 'file' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.files.map((f) => f.id).sort()).toEqual([
      'notes',
      'report',
    ]);
  });

  test('--type other returns images / forms / sites / shortcuts excluded', async () => {
    const response = await run({ recursive: true, type: 'other' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.files.map((f) => f.id)).toEqual(['logo']);
  });

  test('--type shortcut filters to shortcut nodes', async () => {
    ctx.cleanup();
    ctx = useTempDb('list-shortcut');
    seedTempDb(ctx.dbPath, [
      nodeInput({ id: MY_DRIVE_ID, name: 'My Drive', parentId: null }),
      nodeInput({
        id: 'sc1',
        name: 'pointer',
        parentId: MY_DRIVE_ID,
        mimeType: 'application/vnd.google-apps.shortcut',
      }),
      nodeInput({
        id: 'doc1',
        name: 'doc',
        parentId: MY_DRIVE_ID,
        mimeType: 'application/pdf',
      }),
    ]);
    const response = await run({ recursive: true, type: 'shortcut' });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.files.map((f) => f.id)).toEqual(['sc1']);
  });

  test('invalid --type returns USAGE error envelope', async () => {
    const response = await run({ type: 'bogus' });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.code).toBe('USAGE');
    expect(response.error).toMatch(/--type/);
  });
});

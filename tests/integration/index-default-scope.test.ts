import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { drive_v3 } from '@googleapis/drive';
import { saveWorkspaceConfig } from '../../src/config/workspace.js';
import { stubVault } from '../helpers/fakeVault.js';

const FOLDER = 'application/vnd.google-apps.folder';

interface FakeFile extends drive_v3.Schema$File {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
}

interface FakeTree {
  files: Record<string, FakeFile>;
  children: Record<string, string[]>;
}

// Tree: two independent root folders, each with a distinct child count so
// assertions can tell runs apart. The literal `'root'` sentinel resolves to
// its own tiny tree so the no-config fallback path is exercisable.
const tree: FakeTree = {
  files: {
    'root-a': { id: 'root-a', name: 'Alpha', mimeType: FOLDER },
    'a-doc-1': {
      id: 'a-doc-1',
      name: 'a1.md',
      mimeType: 'text/markdown',
      parents: ['root-a'],
    },
    'a-doc-2': {
      id: 'a-doc-2',
      name: 'a2.md',
      mimeType: 'text/markdown',
      parents: ['root-a'],
    },
    'root-b': { id: 'root-b', name: 'Beta', mimeType: FOLDER },
    'b-doc-1': {
      id: 'b-doc-1',
      name: 'b1.md',
      mimeType: 'text/markdown',
      parents: ['root-b'],
    },
    'b-doc-2': {
      id: 'b-doc-2',
      name: 'b2.md',
      mimeType: 'text/markdown',
      parents: ['root-b'],
    },
    'b-doc-3': {
      id: 'b-doc-3',
      name: 'b3.md',
      mimeType: 'text/markdown',
      parents: ['root-b'],
    },
    'my-drive': { id: 'my-drive', name: 'My Drive', mimeType: FOLDER },
    'my-doc': {
      id: 'my-doc',
      name: 'top.md',
      mimeType: 'text/markdown',
      parents: ['my-drive'],
    },
  },
  children: {
    'root-a': ['a-doc-1', 'a-doc-2'],
    'root-b': ['b-doc-1', 'b-doc-2', 'b-doc-3'],
    'my-drive': ['my-doc'],
  },
};

function makeClient(): drive_v3.Drive {
  const files = {
    async get(params: { fileId: string }) {
      // The literal `'root'` sentinel resolves to `my-drive`.
      const id = params.fileId === 'root' ? 'my-drive' : params.fileId;
      const file = tree.files[id];
      if (!file) throw new Error(`no file ${id}`);
      return { data: file };
    },
    async list(params: { q: string }) {
      const m = params.q.match(/^'([^']+)' in parents/);
      const parent = m?.[1] ?? '';
      const ids = tree.children[parent] ?? [];
      return { data: { files: ids.map((id) => tree.files[id]) } };
    },
  };
  return { files } as unknown as drive_v3.Drive;
}

mock.module('../../src/drive/client.js', () => ({
  createDriveClient: async () => makeClient(),
}));

describe('gdrivescope index default-scope resolution', () => {
  let tmpDir: string;
  let dbPath: string;
  let configPath: string;
  let restoreVault: (() => void) | undefined;

  beforeEach(() => {
    restoreVault = stubVault();
    tmpDir = mkdtempSync(join(tmpdir(), 'gdrivescope-default-'));
    dbPath = join(tmpDir, 'drive.db');
    configPath = join(tmpDir, 'config.toml');
    Bun.env.GDRIVESCOPE_DB = dbPath;
    Bun.env.GDRIVESCOPE_CONFIG = configPath;
  });

  afterEach(() => {
    delete Bun.env.GDRIVESCOPE_DB;
    delete Bun.env.GDRIVESCOPE_CONFIG;
    rmSync(tmpDir, { recursive: true, force: true });
    restoreVault?.();
    restoreVault = undefined;
  });

  test('single configured root is used when --scope is omitted', async () => {
    await saveWorkspaceConfig(
      {
        roots: [{ id: 'root-a', label: 'Alpha' }],
        folders: {},
      },
      configPath
    );
    const { run } = await import('../../src/cli/commands/index.js');
    const response = await run({ 'metadata-only': true });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.runs).toHaveLength(1);
    const only = response.data.runs[0];
    expect(only).toBeDefined();
    if (!only) return;
    expect(only.rootId).toBe('root-a');
    expect(only.rootLabel).toBe('Alpha');
    expect(only.usedFallback).toBe(false);
    // root + 2 docs
    expect(only.visited).toBe(3);
    expect(only.files).toBe(2);
  });

  test('every configured root is iterated when --scope is omitted', async () => {
    await saveWorkspaceConfig(
      {
        roots: [
          { id: 'root-a', label: 'Alpha' },
          { id: 'root-b', label: 'Beta' },
        ],
        folders: {},
      },
      configPath
    );
    const { run } = await import('../../src/cli/commands/index.js');
    const response = await run({ 'metadata-only': true });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.runs).toHaveLength(2);
    const rootIds = response.data.runs.map((r) => r.rootId);
    expect(rootIds.sort()).toEqual(['root-a', 'root-b']);
    const alpha = response.data.runs.find((r) => r.rootId === 'root-a');
    const beta = response.data.runs.find((r) => r.rootId === 'root-b');
    expect(alpha?.files).toBe(2);
    expect(beta?.files).toBe(3);
    // Both roots wrote to the shared DB.
    const db = new Database(dbPath, { readonly: true });
    try {
      const rootCounts = db
        .query<{ root_id: string | null; c: number }, []>(
          'SELECT root_id, COUNT(*) AS c FROM nodes GROUP BY root_id ORDER BY root_id'
        )
        .all();
      expect(rootCounts.map((r) => r.root_id)).toEqual(['root-a', 'root-b']);
    } finally {
      db.close();
    }
  });

  test('legacy behaviour: no configured roots and no --scope falls back to My Drive', async () => {
    await saveWorkspaceConfig({ roots: [], folders: {} }, configPath);
    const { run } = await import('../../src/cli/commands/index.js');
    const response = await run({ 'metadata-only': true });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.runs).toHaveLength(1);
    const only = response.data.runs[0];
    expect(only).toBeDefined();
    if (!only) return;
    // The literal 'root' sentinel resolves to my-drive in the fake.
    expect(only.rootId).toBe('my-drive');
  });

  test('--scope overrides configured roots', async () => {
    await saveWorkspaceConfig(
      {
        roots: [
          { id: 'root-a', label: 'Alpha' },
          { id: 'root-b', label: 'Beta' },
        ],
        folders: {},
      },
      configPath
    );
    const { run } = await import('../../src/cli/commands/index.js');
    const response = await run({
      scope: 'root-b',
      'metadata-only': true,
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.runs).toHaveLength(1);
    const only = response.data.runs[0];
    expect(only).toBeDefined();
    if (!only) return;
    expect(only.rootId).toBe('root-b');
    expect(only.files).toBe(3);
  });
});

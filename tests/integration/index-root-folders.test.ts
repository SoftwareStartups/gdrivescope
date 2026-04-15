import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { drive_v3 } from '@googleapis/drive';
import { saveWorkspaceConfig } from '../../src/config/workspace.js';

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

function makeClient(tree: FakeTree): drive_v3.Drive {
  const files = {
    async get(params: { fileId: string; fields?: string }) {
      const id = params.fileId === 'root' ? 'company-root' : params.fileId;
      const file = tree.files[id];
      if (!file) throw new Error(`no file ${id}`);
      return { data: file };
    },
    async list(params: { q: string; pageSize?: number; pageToken?: string }) {
      const m = params.q.match(/^'([^']+)' in parents/);
      const parent = m?.[1] ?? '';
      const ids = tree.children[parent] ?? [];
      return { data: { files: ids.map((id) => tree.files[id]) } };
    },
  };
  return { files } as unknown as drive_v3.Drive;
}

const tree: FakeTree = {
  files: {
    'company-root': {
      id: 'company-root',
      name: 'Company',
      mimeType: FOLDER,
    },
    projects: {
      id: 'projects',
      name: 'Projects',
      mimeType: FOLDER,
      parents: ['company-root'],
    },
    acme: {
      id: 'acme',
      name: 'Acme',
      mimeType: FOLDER,
      parents: ['projects'],
    },
    'acme-doc': {
      id: 'acme-doc',
      name: 'acme.md',
      mimeType: 'text/markdown',
      parents: ['acme'],
    },
    beta: {
      id: 'beta',
      name: 'Beta',
      mimeType: FOLDER,
      parents: ['projects'],
    },
    'beta-doc': {
      id: 'beta-doc',
      name: 'beta.md',
      mimeType: 'text/markdown',
      parents: ['beta'],
    },
  },
  children: {
    'company-root': ['projects'],
    projects: ['acme', 'beta'],
    acme: ['acme-doc'],
    beta: ['beta-doc'],
  },
};

mock.module('../../src/drive/client.js', () => ({
  createDriveClient: async () => makeClient(tree),
}));

describe('index command with configured root', () => {
  let tmpDir: string;
  let dbPath: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gdrivescope-root-'));
    dbPath = join(tmpDir, 'drive.db');
    configPath = join(tmpDir, 'config.toml');
    Bun.env.GDRIVESCOPE_DB = dbPath;
    Bun.env.GDRIVESCOPE_CONFIG = configPath;
    await saveWorkspaceConfig(
      {
        roots: [{ id: 'company-root', label: 'Company Drive' }],
        folders: {},
      },
      configPath
    );
  });

  afterEach(() => {
    delete Bun.env.GDRIVESCOPE_DB;
    delete Bun.env.GDRIVESCOPE_CONFIG;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('indexing two sibling scopes produces one connected graph', async () => {
    const { run } = await import('../../src/cli/commands/index.js');

    const first = await run({ scope: 'acme', 'metadata-only': true });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.rootId).toBe('company-root');
    expect(first.data.rootLabel).toBe('Company Drive');
    expect(first.data.ancestryPath).toEqual([
      'Company Drive',
      'Projects',
      'Acme',
    ]);
    expect(first.data.usedFallback).toBe(false);

    const second = await run({ scope: 'beta', 'metadata-only': true });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.rootId).toBe('company-root');
    expect(second.data.ancestryPath).toEqual([
      'Company Drive',
      'Projects',
      'Beta',
    ]);

    const db = new Database(dbPath, { readonly: true });
    try {
      // Every stored node should be tagged with the configured root.
      const rootCounts = db
        .query<{ root_id: string | null; c: number }, []>(
          'SELECT root_id, COUNT(*) AS c FROM nodes GROUP BY root_id'
        )
        .all();
      expect(rootCounts).toHaveLength(1);
      expect(rootCounts[0]?.root_id).toBe('company-root');

      // Shared ancestors are deduplicated: one Company, one Projects.
      const company = db
        .query<{ id: string; parent_id: string | null; name: string }, []>(
          "SELECT id, parent_id, name FROM nodes WHERE id = 'company-root'"
        )
        .get();
      expect(company?.parent_id).toBeNull();
      // Name reflects config label override.
      expect(company?.name).toBe('Company Drive');

      const projects = db
        .query<{ id: string; parent_id: string | null }, []>(
          "SELECT id, parent_id FROM nodes WHERE id = 'projects'"
        )
        .get();
      expect(projects?.parent_id).toBe('company-root');

      // Both subtrees present under the shared parent.
      const projectChildren = db
        .query<{ id: string }, []>(
          "SELECT id FROM nodes WHERE parent_id = 'projects' ORDER BY id"
        )
        .all();
      expect(projectChildren.map((r) => r.id).sort()).toEqual(['acme', 'beta']);

      // Individual doc nodes were persisted.
      const docs = db
        .query<{ c: number }, []>(
          "SELECT COUNT(*) AS c FROM nodes WHERE id IN ('acme-doc', 'beta-doc')"
        )
        .get();
      expect(docs?.c).toBe(2);
    } finally {
      db.close();
    }
  });

  test('fallback when scope is not under any configured root', async () => {
    // Reconfigure with an unrelated root id.
    await saveWorkspaceConfig(
      {
        roots: [{ id: 'unknown-root', label: 'Unknown' }],
        folders: {},
      },
      configPath
    );

    const { run } = await import('../../src/cli/commands/index.js');
    const result = await run({ scope: 'acme', 'metadata-only': true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.usedFallback).toBe(true);
    expect(result.data.rootId).toBe('acme');
    expect(result.data.rootLabel).toBe('Acme');
    expect(result.data.ancestryPath).toEqual(['Acme']);
  });
});

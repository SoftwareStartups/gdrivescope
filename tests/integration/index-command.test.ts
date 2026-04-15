import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { makeFakeDrive } from '../helpers/fakeDrive.js';

const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';

// Shared fake — created lazily so mock.module can close over it.
const fake = makeFakeDrive({
  root: { id: 'root', name: 'Root', mimeType: FOLDER },
  children: {
    root: [
      { id: 'docs', name: 'Docs', mimeType: FOLDER },
      { id: 'images', name: 'Images', mimeType: FOLDER },
      {
        id: 'sc1',
        name: 'report-shortcut',
        mimeType: SHORTCUT,
        shortcutDetails: { targetId: 'report' },
      },
    ],
    docs: [
      {
        id: 'report',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        size: '1024',
      },
      { id: 'notes', name: 'notes.md', mimeType: 'text/markdown' },
    ],
    images: [{ id: 'logo', name: 'logo.png', mimeType: 'image/png' }],
  },
});

mock.module('../../src/drive/client.js', () => ({
  createDriveClient: async () => fake.client,
}));

describe('gdrivescope index (integration)', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gdrivescope-index-'));
    dbPath = join(tmpDir, 'drive.db');
    Bun.env.GDRIVESCOPE_DB = dbPath;
  });

  afterEach(() => {
    delete Bun.env.GDRIVESCOPE_DB;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('populates the nodes table and returns an ok envelope', async () => {
    const { run } = await import('../../src/cli/commands/index.js');
    const response = await run({ scope: 'root' });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.data.visited).toBe(7);
    expect(response.data.folders).toBe(3);
    expect(response.data.files).toBe(4);
    expect(response.data.rootId).toBe('root');
    expect(response.data.dbPath).toBe(dbPath);

    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM nodes')
        .get();
      expect(row?.c).toBe(7);
      const meta = db
        .query<{ v: string }, [string]>('SELECT v FROM meta WHERE k = ?')
        .get('last_index_run');
      expect(meta?.v).toBeDefined();
      const schema = db
        .query<{ v: string }, [string]>('SELECT v FROM meta WHERE k = ?')
        .get('schema_version');
      expect(schema?.v).toBe('2');
    } finally {
      db.close();
    }
  });

  test('re-run is idempotent — same row count, last_index_run advances', async () => {
    const { run } = await import('../../src/cli/commands/index.js');

    const first = await run({ scope: 'root' });
    expect(first.ok).toBe(true);

    const db1 = new Database(dbPath, { readonly: true });
    const firstRun = db1
      .query<{ v: string }, [string]>('SELECT v FROM meta WHERE k = ?')
      .get('last_index_run')?.v;
    db1.close();

    // Ensure wall-clock advances for the last_index_run string comparison.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await run({ scope: 'root' });
    expect(second.ok).toBe(true);

    const db2 = new Database(dbPath, { readonly: true });
    try {
      const count = db2
        .query<{ c: number }, []>('SELECT COUNT(*) AS c FROM nodes')
        .get();
      expect(count?.c).toBe(7);
      const secondRun = db2
        .query<{ v: string }, [string]>('SELECT v FROM meta WHERE k = ?')
        .get('last_index_run')?.v;
      expect(secondRun).toBeDefined();
      expect(firstRun).toBeDefined();
      expect((secondRun ?? '') >= (firstRun ?? '')).toBe(true);
    } finally {
      db2.close();
    }
  });
});

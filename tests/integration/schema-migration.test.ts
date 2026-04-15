import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../src/graph/store.js';

describe('store schema migration 2 → 3', () => {
  let workDir: string;
  let dbPath: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'gdrivescope-migrate-'));
    dbPath = join(workDir, 'drive.db');
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test('non-destructively adds last_error column and bumps version', () => {
    // Seed a pre-Stage-5 database: schema_version = '2', no last_error column.
    const seed = new Database(dbPath, { create: true });
    seed.exec(
      "CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL); INSERT INTO meta(k,v) VALUES ('schema_version', '2');"
    );
    seed.exec(`
      CREATE TABLE nodes (
        id             TEXT PRIMARY KEY,
        parent_id      TEXT,
        name           TEXT NOT NULL,
        mime_type      TEXT NOT NULL,
        size           INTEGER,
        modified_time  TEXT,
        created_time   TEXT,
        web_view_link  TEXT,
        root_id        TEXT,
        metadata_json  TEXT NOT NULL,
        summary        TEXT,
        classification TEXT,
        key_topics     TEXT,
        extracted_md   TEXT,
        content_hash   TEXT,
        last_indexed   TEXT
      )
    `);
    seed
      .prepare(
        `INSERT INTO nodes (id, parent_id, name, mime_type, metadata_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run('file_a', null, 'Old File', 'application/pdf', '{}');
    seed.close();

    // Re-open via stage-5 openStore: migration should run.
    const store = openStore(dbPath);
    expect(store.getMeta('schema_version')).toBe('3');

    interface PragmaRow {
      name: string;
    }
    const cols = store.db
      .prepare('PRAGMA table_info(nodes)')
      .all() as PragmaRow[];
    expect(cols.some((c) => c.name === 'last_error')).toBe(true);

    // Existing row still reads back correctly through rowToNode.
    const node = store.getNode('file_a');
    expect(node).not.toBeNull();
    expect(node?.name).toBe('Old File');
    expect(node?.lastError).toBeNull();

    // New methods work end-to-end.
    store.recordError('file_a', 'boom');
    expect(store.getNode('file_a')?.lastError).toBe('boom');

    store.updateSummary('file_a', {
      summary: 's',
      classification: 'other',
      keyTopics: JSON.stringify(['t']),
      extractedMd: '# md',
      contentHash: 'h',
    });
    const after = store.getNode('file_a');
    expect(after?.summary).toBe('s');
    expect(after?.lastError).toBeNull();

    store.close();
  });
});

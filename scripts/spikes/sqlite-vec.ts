#!/usr/bin/env bun
// Spike R3 — verify sqlite-vec loads under bun:sqlite and a basic
// vec0 virtual table + nearest-neighbor query works end-to-end.

import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';

// Bun's bundled SQLite is compiled WITHOUT extension-loading support.
// To load `sqlite-vec` we must point Bun at a system SQLite that does.
// macOS: Homebrew's keg-only sqlite (`brew install sqlite`).
// Linux: libsqlite3.so.0 (Debian/Ubuntu ship an extension-enabled build).
// Env override `GDRIVESCOPE_SQLITE_LIB` lets CI/users substitute their own.
function resolveCustomSqlitePath(): string | null {
  const override = Bun.env.GDRIVESCOPE_SQLITE_LIB;
  if (override) return override;
  if (process.platform === 'darwin') {
    return '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib';
  }
  if (process.platform === 'linux') {
    return 'libsqlite3.so.0';
  }
  return null;
}

const customSqlite = resolveCustomSqlitePath();
if (customSqlite) {
  process.stderr.write(`spike: using custom sqlite at ${customSqlite}\n`);
  Database.setCustomSQLite(customSqlite);
}

const db = new Database(':memory:');

// sqlite-vec `load(db)` just calls db.loadExtension with the platform
// shared-library path it resolves from its optional deps.
sqliteVec.load(db);

const [{ version }] = db
  .query<{ version: string }, []>('SELECT vec_version() AS version')
  .all();
process.stderr.write(`spike: vec_version=${version}\n`);

db.exec('CREATE VIRTUAL TABLE items USING vec0(embedding FLOAT[4])');

const insert = db.prepare('INSERT INTO items(rowid, embedding) VALUES (?, ?)');
const vectors: Array<[number, number[]]> = [
  [1, [0.1, 0.1, 0.1, 0.1]],
  [2, [0.9, 0.9, 0.9, 0.9]],
  [3, [0.2, 0.1, 0.2, 0.1]],
];
for (const [id, vec] of vectors) {
  insert.run(id, new Uint8Array(new Float32Array(vec).buffer));
}

const query = new Float32Array([0.15, 0.1, 0.15, 0.1]);
const rows = db
  .query<{ rowid: number; distance: number }, [Uint8Array, number]>(
    `SELECT rowid, distance
     FROM items
     WHERE embedding MATCH ? AND k = ?
     ORDER BY distance`
  )
  .all(new Uint8Array(query.buffer), 3);

process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
process.stderr.write('spike: OK — nearest-neighbor query returned\n');

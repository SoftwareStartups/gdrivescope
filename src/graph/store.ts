import { Database, type Statement } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { CliError } from '../utils/errors.js';
import type { DriveNodeInput, Node } from './model.js';
import { ensureExtensionCapableSqlite } from './sqlite-native.js';

export interface RootSummary {
  rootId: string | null;
  count: number;
}

export interface SummaryUpdate {
  summary: string;
  classification: string;
  keyTopics: string;
  extractedMd: string;
  contentHash: string;
}

export interface NodeNameSearchRow {
  id: string;
  name: string;
  mimeType: string;
  parentId: string | null;
  classification: string | null;
}

export interface InitVectorTableOptions {
  rebuild?: boolean;
}

export interface KnnHit {
  node: Node;
  distance: number;
}

export interface Store {
  db: Database;
  upsertNode(node: DriveNodeInput): void;
  upsertNodes(nodes: readonly DriveNodeInput[]): void;
  getNode(id: string): Node | null;
  listChildren(parentId: string | null): Node[];
  allNodes(): Node[];
  nodeCount(): number;
  listRoots(): RootSummary[];
  setMeta(key: string, value: string): void;
  getMeta(key: string): string | null;
  updateSummary(id: string, patch: SummaryUpdate): void;
  recordError(id: string, message: string): void;
  searchByName(query: string, classification?: string): NodeNameSearchRow[];
  deleteNodes(ids: readonly string[]): void;
  initVectorTable(dimensions: number, opts?: InitVectorTableOptions): void;
  upsertEmbedding(nodeId: string, vector: Float32Array): void;
  markEmbedded(nodeId: string, hash: string): void;
  clearEmbeddedHashes(): void;
  clearEmbeddings(): void;
  hasVectorTable(): boolean;
  knnSearch(queryBuf: Uint8Array, k: number): KnnHit[];
  close(): void;
}

export const SCHEMA_VERSION = '3';

interface NodeRow {
  id: string;
  parent_id: string | null;
  name: string;
  mime_type: string;
  size: number | null;
  modified_time: string | null;
  created_time: string | null;
  web_view_link: string | null;
  root_id: string | null;
  metadata_json: string;
  summary: string | null;
  classification: string | null;
  key_topics: string | null;
  extracted_md: string | null;
  content_hash: string | null;
  last_embedded_hash: string | null;
  last_indexed: string | null;
  last_error: string | null;
}

interface RootSummaryRow {
  root_id: string | null;
  c: number;
}

interface MetaRow {
  v: string;
}

interface CountRow {
  c: number;
}

function rowToNode(row: NodeRow): Node {
  return {
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size ?? undefined,
    modifiedTime: row.modified_time ?? undefined,
    createdTime: row.created_time ?? undefined,
    webViewLink: row.web_view_link ?? undefined,
    rootId: row.root_id,
    metadataJson: row.metadata_json,
    summary: row.summary,
    classification: row.classification,
    keyTopics: row.key_topics,
    extractedMd: row.extracted_md,
    contentHash: row.content_hash,
    lastEmbeddedHash: row.last_embedded_hash,
    lastIndexed: row.last_indexed,
    lastError: row.last_error,
  };
}

const KNOWN_TABLES = new Set(['nodes', 'meta', 'embeddings']);

function hasColumn(db: Database, table: string, column: string): boolean {
  if (!KNOWN_TABLES.has(table)) {
    throw new Error(`hasColumn: unknown table "${table}"`);
  }
  interface PragmaRow {
    name: string;
  }
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as PragmaRow[];
  return rows.some((r) => r.name === column);
}

export function openStore(path: string): Store {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  ensureExtensionCapableSqlite();
  const db = new Database(path, { create: true });
  try {
    sqliteVec.load(db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(
      `Failed to load sqlite-vec extension: ${msg}. Install a build of SQLite with extension support (macOS: brew install sqlite; Linux: libsqlite3.so.0) or set GDRIVESCOPE_SQLITE_LIB to a capable libsqlite path.`,
      'VEC_EXTENSION_FAILED'
    );
  }
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
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
      last_indexed   TEXT,
      last_error     TEXT
    );
  `);
  if (!hasColumn(db, 'nodes', 'root_id')) {
    db.exec('ALTER TABLE nodes ADD COLUMN root_id TEXT');
  }
  if (!hasColumn(db, 'nodes', 'last_error')) {
    db.exec('ALTER TABLE nodes ADD COLUMN last_error TEXT');
  }
  if (!hasColumn(db, 'nodes', 'last_embedded_hash')) {
    db.exec('ALTER TABLE nodes ADD COLUMN last_embedded_hash TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_mime ON nodes(mime_type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_root ON nodes(root_id)');

  const upsertStmt: Statement = db.prepare(`
    INSERT INTO nodes (id, parent_id, name, mime_type, size, modified_time,
                       created_time, web_view_link, root_id, metadata_json,
                       last_indexed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(id) DO UPDATE SET
      parent_id     = excluded.parent_id,
      name          = excluded.name,
      mime_type     = excluded.mime_type,
      size          = excluded.size,
      modified_time = excluded.modified_time,
      created_time  = excluded.created_time,
      web_view_link = excluded.web_view_link,
      root_id       = excluded.root_id,
      metadata_json = excluded.metadata_json,
      last_indexed  = excluded.last_indexed
  `);
  const getNodeStmt = db.prepare('SELECT * FROM nodes WHERE id = ?');
  const listChildrenByParentStmt = db.prepare(
    'SELECT * FROM nodes WHERE parent_id = ? ORDER BY name ASC'
  );
  const listChildrenNullStmt = db.prepare(
    'SELECT * FROM nodes WHERE parent_id IS NULL ORDER BY name ASC'
  );
  const allNodesStmt = db.prepare('SELECT * FROM nodes ORDER BY name ASC');
  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM nodes');
  const listRootsStmt = db.prepare(
    'SELECT root_id, COUNT(*) AS c FROM nodes GROUP BY root_id ORDER BY root_id'
  );
  const setMetaStmt = db.prepare(
    'INSERT INTO meta(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'
  );
  const getMetaStmt = db.prepare('SELECT v FROM meta WHERE k = ?');
  const updateSummaryStmt = db.prepare(`
    UPDATE nodes SET
      summary        = ?,
      classification = ?,
      key_topics     = ?,
      extracted_md   = ?,
      content_hash   = ?,
      last_error     = NULL,
      last_indexed   = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `);
  const markEmbeddedStmt = db.prepare(
    'UPDATE nodes SET last_embedded_hash = ? WHERE id = ?'
  );
  const clearEmbeddedHashesStmt = db.prepare(
    'UPDATE nodes SET last_embedded_hash = NULL'
  );
  const recordErrorStmt = db.prepare(
    'UPDATE nodes SET last_error = ? WHERE id = ?'
  );
  const deleteNodeStmt = db.prepare('DELETE FROM nodes WHERE id = ?');
  const searchByNameStmt = db.prepare(
    'SELECT id, name, mime_type, parent_id, classification FROM nodes WHERE LOWER(name) LIKE ?'
  );
  const searchByNameClassStmt = db.prepare(
    'SELECT id, name, mime_type, parent_id, classification FROM nodes WHERE LOWER(name) LIKE ? AND classification = ?'
  );

  const existing = getMetaStmt.get('schema_version') as MetaRow | null;
  if (!existing) {
    setMetaStmt.run('schema_version', SCHEMA_VERSION);
  } else if (existing.v !== SCHEMA_VERSION) {
    setMetaStmt.run('schema_version', SCHEMA_VERSION);
  }

  // vec0 virtual tables do not support `INSERT ... ON CONFLICT`, so upsert
  // is implemented as DELETE + INSERT. Statements are prepared lazily
  // because they bind against a virtual table that may not exist yet.
  let deleteEmbeddingStmt: Statement | null = null;
  let insertEmbeddingStmt: Statement | null = null;
  let knnStmt: Statement | null = null;
  const deleteEmbeddingDimsMeta = db.prepare(
    "DELETE FROM meta WHERE k = 'embedding_dims'"
  );

  function hasVec(): boolean {
    const row = getMetaStmt.get('embedding_dims') as MetaRow | null;
    return row !== null;
  }

  function resetEmbeddingStmts(): void {
    deleteEmbeddingStmt = null;
    insertEmbeddingStmt = null;
    knnStmt = null;
  }

  function initVec(dims: number, opts?: InitVectorTableOptions): void {
    if (!Number.isInteger(dims) || dims < 1 || dims > 65536) {
      throw new CliError(
        `Invalid embedding dimensions: ${dims} (must be integer 1–65536)`,
        'BAD_ARG'
      );
    }
    if (opts?.rebuild) {
      db.exec('DROP TABLE IF EXISTS embeddings');
      deleteEmbeddingDimsMeta.run();
      resetEmbeddingStmts();
    }
    const row = getMetaStmt.get('embedding_dims') as MetaRow | null;
    if (row) {
      if (row.v === String(dims)) return;
      throw new CliError(
        `Store has ${row.v}-dim vectors, provider is ${dims}-dim. Re-run with --rebuild-embeddings or match the original provider.`,
        'EMBEDDING_DIM_MISMATCH'
      );
    }
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(node_id TEXT PRIMARY KEY, embedding FLOAT[${dims}] distance_metric=cosine)`
    );
    setMetaStmt.run('embedding_dims', String(dims));
  }

  function getDeleteEmbeddingStmt(): Statement {
    if (!deleteEmbeddingStmt) {
      deleteEmbeddingStmt = db.prepare(
        'DELETE FROM embeddings WHERE node_id = ?'
      );
    }
    return deleteEmbeddingStmt;
  }

  function getInsertEmbeddingStmt(): Statement {
    if (!insertEmbeddingStmt) {
      insertEmbeddingStmt = db.prepare(
        'INSERT INTO embeddings(node_id, embedding) VALUES (?, ?)'
      );
    }
    return insertEmbeddingStmt;
  }

  function getKnnStmt(): Statement {
    if (!knnStmt) {
      knnStmt = db.prepare(
        `SELECT n.*, e.distance AS distance
           FROM embeddings e
           JOIN nodes n ON n.id = e.node_id
           WHERE e.embedding MATCH ? AND e.k = ?
           ORDER BY e.distance`
      );
    }
    return knnStmt;
  }

  function runUpsert(node: DriveNodeInput): void {
    upsertStmt.run(
      node.id,
      node.parentId,
      node.name,
      node.mimeType,
      node.size ?? null,
      node.modifiedTime ?? null,
      node.createdTime ?? null,
      node.webViewLink ?? null,
      node.rootId ?? null,
      JSON.stringify(node.metadata)
    );
  }

  return {
    db,
    upsertNode: runUpsert,
    upsertNodes(nodes: readonly DriveNodeInput[]): void {
      if (nodes.length === 0) return;
      db.transaction(() => {
        for (const n of nodes) runUpsert(n);
      })();
    },
    getNode(id: string): Node | null {
      const row = getNodeStmt.get(id) as NodeRow | null;
      return row ? rowToNode(row) : null;
    },
    listChildren(parentId: string | null): Node[] {
      const rows = (
        parentId === null
          ? listChildrenNullStmt.all()
          : listChildrenByParentStmt.all(parentId)
      ) as NodeRow[];
      return rows.map(rowToNode);
    },
    allNodes(): Node[] {
      return (allNodesStmt.all() as NodeRow[]).map(rowToNode);
    },
    nodeCount(): number {
      const row = countStmt.get() as CountRow;
      return row.c;
    },
    listRoots(): RootSummary[] {
      const rows = listRootsStmt.all() as RootSummaryRow[];
      return rows.map((r) => ({ rootId: r.root_id, count: r.c }));
    },
    setMeta(key: string, value: string): void {
      setMetaStmt.run(key, value);
    },
    getMeta(key: string): string | null {
      const row = getMetaStmt.get(key) as MetaRow | null;
      return row ? row.v : null;
    },
    updateSummary(id: string, patch: SummaryUpdate): void {
      updateSummaryStmt.run(
        patch.summary,
        patch.classification,
        patch.keyTopics,
        patch.extractedMd,
        patch.contentHash,
        id
      );
    },
    recordError(id: string, message: string): void {
      recordErrorStmt.run(message, id);
    },
    searchByName(query: string, classification?: string): NodeNameSearchRow[] {
      interface Row {
        id: string;
        name: string;
        mime_type: string;
        parent_id: string | null;
        classification: string | null;
      }
      const rows = (
        classification
          ? searchByNameClassStmt.all(`%${query}%`, classification)
          : searchByNameStmt.all(`%${query}%`)
      ) as Row[];
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        mimeType: r.mime_type,
        parentId: r.parent_id,
        classification: r.classification,
      }));
    },
    deleteNodes(ids: readonly string[]): void {
      if (ids.length === 0) return;
      const hasEmbeddings = hasVec();
      const deleteEmbedding = hasEmbeddings ? getDeleteEmbeddingStmt() : null;
      db.transaction(() => {
        for (const id of ids) {
          deleteEmbedding?.run(id);
          deleteNodeStmt.run(id);
        }
      })();
    },
    initVectorTable(dimensions: number, opts?: InitVectorTableOptions): void {
      initVec(dimensions, opts);
    },
    upsertEmbedding(nodeId: string, vector: Float32Array): void {
      const bytes = new Uint8Array(
        vector.buffer,
        vector.byteOffset,
        vector.byteLength
      );
      getDeleteEmbeddingStmt().run(nodeId);
      getInsertEmbeddingStmt().run(nodeId, bytes);
    },
    markEmbedded(nodeId: string, hash: string): void {
      markEmbeddedStmt.run(hash, nodeId);
    },
    clearEmbeddedHashes(): void {
      clearEmbeddedHashesStmt.run();
    },
    clearEmbeddings(): void {
      db.exec('DROP TABLE IF EXISTS embeddings');
      deleteEmbeddingDimsMeta.run();
      resetEmbeddingStmts();
    },
    hasVectorTable(): boolean {
      return hasVec();
    },
    knnSearch(queryBuf: Uint8Array, k: number): KnnHit[] {
      const rows = getKnnStmt().all(queryBuf, k) as Array<
        NodeRow & { distance: number }
      >;
      return rows.map((row) => ({
        node: rowToNode(row),
        distance: row.distance,
      }));
    },
    close(): void {
      db.close();
    },
  };
}

export function withStore<T>(path: string, fn: (store: Store) => T): T {
  const store = openStore(path);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

export async function withStoreAsync<T>(
  path: string,
  fn: (store: Store) => Promise<T>
): Promise<T> {
  const store = openStore(path);
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

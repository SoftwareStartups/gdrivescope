import { Database, type Statement } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DriveNodeInput, Node } from './model.js';

export interface Store {
  db: Database;
  upsertNode(node: DriveNodeInput): void;
  getNode(id: string): Node | null;
  listChildren(parentId: string | null): Node[];
  allNodes(): Node[];
  nodeCount(): number;
  setMeta(key: string, value: string): void;
  getMeta(key: string): string | null;
  close(): void;
}

export const SCHEMA_VERSION = '1';

interface NodeRow {
  id: string;
  parent_id: string | null;
  name: string;
  mime_type: string;
  size: number | null;
  modified_time: string | null;
  created_time: string | null;
  web_view_link: string | null;
  metadata_json: string;
  summary: string | null;
  classification: string | null;
  key_topics: string | null;
  extracted_md: string | null;
  content_hash: string | null;
  last_indexed: string | null;
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
    metadataJson: row.metadata_json,
    summary: row.summary,
    classification: row.classification,
    keyTopics: row.key_topics,
    extractedMd: row.extracted_md,
    contentHash: row.content_hash,
    lastIndexed: row.last_indexed,
  };
}

export function openStore(path: string): Store {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
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
      metadata_json  TEXT NOT NULL,
      summary        TEXT,
      classification TEXT,
      key_topics     TEXT,
      extracted_md   TEXT,
      content_hash   TEXT,
      last_indexed   TEXT
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_nodes_mime ON nodes(mime_type)');

  const upsertStmt: Statement = db.prepare(`
    INSERT INTO nodes (id, parent_id, name, mime_type, size, modified_time,
                       created_time, web_view_link, metadata_json, last_indexed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(id) DO UPDATE SET
      parent_id     = excluded.parent_id,
      name          = excluded.name,
      mime_type     = excluded.mime_type,
      size          = excluded.size,
      modified_time = excluded.modified_time,
      created_time  = excluded.created_time,
      web_view_link = excluded.web_view_link,
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
  const setMetaStmt = db.prepare(
    'INSERT INTO meta(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v'
  );
  const getMetaStmt = db.prepare('SELECT v FROM meta WHERE k = ?');

  const existing = getMetaStmt.get('schema_version') as MetaRow | null;
  if (!existing) {
    setMetaStmt.run('schema_version', SCHEMA_VERSION);
  }

  return {
    db,
    upsertNode(node: DriveNodeInput): void {
      upsertStmt.run(
        node.id,
        node.parentId,
        node.name,
        node.mimeType,
        node.size ?? null,
        node.modifiedTime ?? null,
        node.createdTime ?? null,
        node.webViewLink ?? null,
        JSON.stringify(node.metadata)
      );
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
    setMeta(key: string, value: string): void {
      setMetaStmt.run(key, value);
    },
    getMeta(key: string): string | null {
      const row = getMetaStmt.get(key) as MetaRow | null;
      return row ? row.v : null;
    },
    close(): void {
      db.close();
    },
  };
}

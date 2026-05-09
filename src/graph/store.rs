//! SQLite + sqlite-vec store. `rusqlite` with the `bundled` feature
//! statically links a known-good SQLite that supports loadable extensions
//! — no system libsqlite3 dylib required.
//!
//! sqlite-vec is registered once via `sqlite3_auto_extension` so every
//! subsequent `Connection::open*` picks it up automatically.

use std::path::Path;
use std::sync::Once;

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use super::model::{DriveNodeInput, Node};
use crate::error::{CliError, ErrorCode};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct RootSummary {
    pub root_id: Option<String>,
    pub count: i64,
}

#[derive(Debug, Clone)]
pub struct SummaryUpdate {
    pub summary: String,
    pub classification: String,
    pub key_topics: String,
    pub extracted_md: String,
    pub content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub struct NodeNameSearchRow {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub parent_id: Option<String>,
    pub classification: Option<String>,
}

#[derive(Debug, Clone)]
pub struct KnnHit {
    pub node: Node,
    pub distance: f32,
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self, CliError> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    CliError::new(
                        format!("create_dir_all({}): {e}", parent.display()),
                        ErrorCode::Unknown,
                    )
                })?;
            }
        }
        ensure_vec_extension_registered();
        let conn = Connection::open(path).map_err(|e| {
            CliError::new(
                format!("open {}: {e}", path.display()),
                ErrorCode::VecExtensionFailed,
            )
        })?;
        let store = Self { conn };
        store.init_pragmas_and_schema(true)?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self, CliError> {
        ensure_vec_extension_registered();
        let conn = Connection::open_in_memory().map_err(|e| {
            CliError::new(
                format!("open_in_memory: {e}"),
                ErrorCode::VecExtensionFailed,
            )
        })?;
        let store = Self { conn };
        store.init_pragmas_and_schema(false)?;
        Ok(store)
    }

    fn init_pragmas_and_schema(&self, with_wal: bool) -> Result<(), CliError> {
        if with_wal {
            // WAL is meaningless on :memory: and triggers a benign warning.
            self.conn
                .execute_batch("PRAGMA journal_mode = WAL;")
                .map_err(map_err("PRAGMA journal_mode"))?;
        }
        self.conn
            .execute_batch(SCHEMA_DDL)
            .map_err(map_err("init schema"))?;
        Ok(())
    }

    pub fn upsert_node(&self, node: &DriveNodeInput) -> Result<(), CliError> {
        let metadata_json = serde_json::to_string(&node.metadata).map_err(|e| {
            CliError::new(format!("serialize node.metadata: {e}"), ErrorCode::Unknown)
        })?;
        let mut stmt = self
            .conn
            .prepare_cached(UPSERT_NODE_SQL)
            .map_err(map_err("prepare upsert_node"))?;
        stmt.execute(params![
            node.id,
            node.parent_id,
            node.name,
            node.mime_type,
            node.size,
            node.modified_time,
            node.created_time,
            node.web_view_link,
            node.root_id,
            metadata_json,
        ])
        .map_err(map_err("execute upsert_node"))?;
        Ok(())
    }

    pub fn upsert_nodes(&self, nodes: &[DriveNodeInput]) -> Result<(), CliError> {
        if nodes.is_empty() {
            return Ok(());
        }
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(map_err("begin tx"))?;
        {
            let mut stmt = tx
                .prepare_cached(UPSERT_NODE_SQL)
                .map_err(map_err("prepare upsert_nodes"))?;
            for node in nodes {
                let metadata_json = serde_json::to_string(&node.metadata)
                    .map_err(|e| CliError::new(format!("serialize: {e}"), ErrorCode::Unknown))?;
                stmt.execute(params![
                    node.id,
                    node.parent_id,
                    node.name,
                    node.mime_type,
                    node.size,
                    node.modified_time,
                    node.created_time,
                    node.web_view_link,
                    node.root_id,
                    metadata_json,
                ])
                .map_err(map_err("execute upsert_nodes"))?;
            }
        }
        tx.commit().map_err(map_err("commit upsert_nodes tx"))?;
        Ok(())
    }

    pub fn get_node(&self, id: &str) -> Result<Option<Node>, CliError> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT * FROM nodes WHERE id = ?")
            .map_err(map_err("prepare get_node"))?;
        let mut rows = stmt.query(params![id]).map_err(map_err("query get_node"))?;
        if let Some(row) = rows.next().map_err(map_err("next get_node"))? {
            Ok(Some(row_to_node(row).map_err(map_err("map get_node"))?))
        } else {
            Ok(None)
        }
    }

    pub fn list_children(&self, parent_id: Option<&str>) -> Result<Vec<Node>, CliError> {
        let nodes = match parent_id {
            None => {
                let mut stmt = self
                    .conn
                    .prepare_cached("SELECT * FROM nodes WHERE parent_id IS NULL ORDER BY name ASC")
                    .map_err(map_err("prepare list_children null"))?;
                let rows = stmt
                    .query([])
                    .map_err(map_err("query list_children null"))?;
                collect_nodes(rows)?
            }
            Some(p) => {
                let mut stmt = self
                    .conn
                    .prepare_cached("SELECT * FROM nodes WHERE parent_id = ? ORDER BY name ASC")
                    .map_err(map_err("prepare list_children"))?;
                let rows = stmt
                    .query(params![p])
                    .map_err(map_err("query list_children"))?;
                collect_nodes(rows)?
            }
        };
        Ok(nodes)
    }

    pub fn all_nodes(&self) -> Result<Vec<Node>, CliError> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT * FROM nodes ORDER BY name ASC")
            .map_err(map_err("prepare all_nodes"))?;
        let rows = stmt.query([]).map_err(map_err("query all_nodes"))?;
        collect_nodes(rows)
    }

    pub fn node_count(&self) -> Result<i64, CliError> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT COUNT(*) FROM nodes")
            .map_err(map_err("prepare count"))?;
        let n: i64 = stmt
            .query_row([], |row| row.get(0))
            .map_err(map_err("query count"))?;
        Ok(n)
    }

    pub fn list_roots(&self) -> Result<Vec<RootSummary>, CliError> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT root_id, COUNT(*) FROM nodes GROUP BY root_id ORDER BY root_id")
            .map_err(map_err("prepare list_roots"))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(RootSummary {
                    root_id: row.get(0)?,
                    count: row.get(1)?,
                })
            })
            .map_err(map_err("query list_roots"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(map_err("collect list_roots"))
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), CliError> {
        let mut stmt = self
            .conn
            .prepare_cached(
                "INSERT INTO meta(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
            )
            .map_err(map_err("prepare set_meta"))?;
        stmt.execute(params![key, value])
            .map_err(map_err("execute set_meta"))?;
        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>, CliError> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT v FROM meta WHERE k = ?")
            .map_err(map_err("prepare get_meta"))?;
        let mut rows = stmt
            .query(params![key])
            .map_err(map_err("query get_meta"))?;
        if let Some(row) = rows.next().map_err(map_err("next get_meta"))? {
            Ok(Some(row.get(0).map_err(map_err("get get_meta"))?))
        } else {
            Ok(None)
        }
    }

    pub fn update_summary(&self, id: &str, patch: &SummaryUpdate) -> Result<(), CliError> {
        let mut stmt = self
            .conn
            .prepare_cached(
                r#"
                UPDATE nodes SET
                  summary        = ?,
                  classification = ?,
                  key_topics     = ?,
                  extracted_md   = ?,
                  content_hash   = ?,
                  last_error     = NULL,
                  last_indexed   = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ?
                "#,
            )
            .map_err(map_err("prepare update_summary"))?;
        stmt.execute(params![
            patch.summary,
            patch.classification,
            patch.key_topics,
            patch.extracted_md,
            patch.content_hash,
            id,
        ])
        .map_err(map_err("execute update_summary"))?;
        Ok(())
    }

    pub fn record_error(&self, id: &str, message: &str) -> Result<(), CliError> {
        let mut stmt = self
            .conn
            .prepare_cached("UPDATE nodes SET last_error = ? WHERE id = ?")
            .map_err(map_err("prepare record_error"))?;
        stmt.execute(params![message, id])
            .map_err(map_err("execute record_error"))?;
        Ok(())
    }

    pub fn search_by_name(
        &self,
        query: &str,
        classification: Option<&str>,
    ) -> Result<Vec<NodeNameSearchRow>, CliError> {
        let pattern = format!("%{}%", query.to_lowercase());
        let map_row = |row: &Row<'_>| -> rusqlite::Result<NodeNameSearchRow> {
            Ok(NodeNameSearchRow {
                id: row.get("id")?,
                name: row.get("name")?,
                mime_type: row.get("mime_type")?,
                parent_id: row.get("parent_id")?,
                classification: row.get("classification")?,
            })
        };
        let rows: Vec<NodeNameSearchRow> = match classification {
            None => {
                let mut stmt = self.conn
                    .prepare_cached(
                        "SELECT id, name, mime_type, parent_id, classification FROM nodes WHERE LOWER(name) LIKE ?",
                    )
                    .map_err(map_err("prepare search_by_name"))?;
                let mapped = stmt
                    .query_map(params![pattern], map_row)
                    .map_err(map_err("query search_by_name"))?;
                mapped
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(map_err("collect search_by_name"))?
            }
            Some(c) => {
                let mut stmt = self.conn
                    .prepare_cached(
                        "SELECT id, name, mime_type, parent_id, classification FROM nodes WHERE LOWER(name) LIKE ? AND classification = ?",
                    )
                    .map_err(map_err("prepare search_by_name+class"))?;
                let mapped = stmt
                    .query_map(params![pattern, c], map_row)
                    .map_err(map_err("query search_by_name+class"))?;
                mapped
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(map_err("collect search_by_name+class"))?
            }
        };
        Ok(rows)
    }

    pub fn delete_nodes(&self, ids: &[String]) -> Result<(), CliError> {
        if ids.is_empty() {
            return Ok(());
        }
        let has_vec = self.has_vector_table()?;
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(map_err("begin delete tx"))?;
        {
            let mut delete_node = tx
                .prepare_cached("DELETE FROM nodes WHERE id = ?")
                .map_err(map_err("prepare delete_node"))?;
            if has_vec {
                let mut delete_emb = tx
                    .prepare_cached("DELETE FROM embeddings WHERE node_id = ?")
                    .map_err(map_err("prepare delete_emb"))?;
                for id in ids {
                    delete_emb
                        .execute(params![id])
                        .map_err(map_err("delete embedding"))?;
                    delete_node
                        .execute(params![id])
                        .map_err(map_err("delete node"))?;
                }
            } else {
                for id in ids {
                    delete_node
                        .execute(params![id])
                        .map_err(map_err("delete node"))?;
                }
            }
        }
        tx.commit().map_err(map_err("commit delete tx"))?;
        Ok(())
    }

    pub fn init_vector_table(&self, dims: usize, rebuild: bool) -> Result<(), CliError> {
        if dims == 0 || dims > 65_536 {
            return Err(CliError::new(
                format!("Invalid embedding dimensions: {dims} (must be integer 1–65536)"),
                ErrorCode::BadArg,
            ));
        }
        if rebuild {
            self.conn
                .execute_batch("DROP TABLE IF EXISTS embeddings;")
                .map_err(map_err("DROP embeddings"))?;
            self.conn
                .execute("DELETE FROM meta WHERE k = 'embedding_dims'", [])
                .map_err(map_err("clear embedding_dims"))?;
        }
        if let Some(existing) = self.get_meta("embedding_dims")? {
            if existing == dims.to_string() {
                return Ok(());
            }
            return Err(CliError::new(
                format!(
                    "Store has {existing}-dim vectors, provider is {dims}-dim. Re-run with --rebuild-embeddings or match the original provider."
                ),
                ErrorCode::EmbeddingDimMismatch,
            ));
        }
        let ddl = format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(node_id TEXT PRIMARY KEY, embedding FLOAT[{dims}] distance_metric=cosine)"
        );
        self.conn
            .execute(&ddl, [])
            .map_err(map_err("CREATE VIRTUAL TABLE embeddings"))?;
        self.set_meta("embedding_dims", &dims.to_string())?;
        Ok(())
    }

    pub fn upsert_embedding(&self, node_id: &str, vector: &[f32]) -> Result<(), CliError> {
        let bytes: &[u8] = bytemuck::cast_slice(vector);
        // vec0 doesn't support ON CONFLICT so we DELETE + INSERT.
        self.conn
            .prepare_cached("DELETE FROM embeddings WHERE node_id = ?")
            .map_err(map_err("prepare delete_emb"))?
            .execute(params![node_id])
            .map_err(map_err("execute delete_emb"))?;
        self.conn
            .prepare_cached("INSERT INTO embeddings(node_id, embedding) VALUES (?, ?)")
            .map_err(map_err("prepare insert_emb"))?
            .execute(params![node_id, bytes])
            .map_err(map_err("execute insert_emb"))?;
        Ok(())
    }

    pub fn mark_embedded(&self, node_id: &str, hash: &str) -> Result<(), CliError> {
        self.conn
            .prepare_cached("UPDATE nodes SET last_embedded_hash = ? WHERE id = ?")
            .map_err(map_err("prepare mark_embedded"))?
            .execute(params![hash, node_id])
            .map_err(map_err("execute mark_embedded"))?;
        Ok(())
    }

    pub fn clear_embedded_hashes_for_ids(&self, ids: &[String]) -> Result<(), CliError> {
        if ids.is_empty() {
            return Ok(());
        }
        let tx = self
            .conn
            .unchecked_transaction()
            .map_err(map_err("begin clear_embedded_hashes tx"))?;
        {
            let mut stmt = tx
                .prepare_cached("UPDATE nodes SET last_embedded_hash = NULL WHERE id = ?")
                .map_err(map_err("prepare clear_embedded_hashes"))?;
            for id in ids {
                stmt.execute(params![id])
                    .map_err(map_err("clear last_embedded_hash"))?;
            }
        }
        tx.commit()
            .map_err(map_err("commit clear_embedded_hashes tx"))?;
        Ok(())
    }

    pub fn clear_embeddings(&self) -> Result<(), CliError> {
        self.conn
            .execute_batch("DROP TABLE IF EXISTS embeddings;")
            .map_err(map_err("DROP embeddings"))?;
        self.conn
            .execute("DELETE FROM meta WHERE k = 'embedding_dims'", [])
            .map_err(map_err("clear embedding_dims"))?;
        Ok(())
    }

    pub fn has_vector_table(&self) -> Result<bool, CliError> {
        Ok(self.get_meta("embedding_dims")?.is_some())
    }

    pub fn knn_search(&self, query: &[f32], k: usize) -> Result<Vec<KnnHit>, CliError> {
        let bytes: &[u8] = bytemuck::cast_slice(query);
        let mut stmt = self
            .conn
            .prepare_cached(
                r#"
                SELECT n.*, e.distance AS distance
                  FROM embeddings e
                  JOIN nodes n ON n.id = e.node_id
                  WHERE e.embedding MATCH ? AND e.k = ?
                  ORDER BY e.distance
                "#,
            )
            .map_err(map_err("prepare knn"))?;
        let hits = stmt
            .query_map(params![bytes, k as i64], |row| {
                let distance: f32 = row.get("distance")?;
                Ok(KnnHit {
                    node: row_to_node(row)?,
                    distance,
                })
            })
            .map_err(map_err("query knn"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_err("collect knn"))?;
        Ok(hits)
    }

    /// Borrow the underlying connection for read-only checks (e.g. tests).
    #[cfg(test)]
    fn conn(&self) -> &Connection {
        &self.conn
    }
}

// --- internal helpers --------------------------------------------------------

const SCHEMA_DDL: &str = r#"
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
  id                 TEXT PRIMARY KEY,
  parent_id          TEXT,
  name               TEXT NOT NULL,
  mime_type          TEXT NOT NULL,
  size               INTEGER,
  modified_time      TEXT,
  created_time       TEXT,
  web_view_link      TEXT,
  root_id            TEXT,
  metadata_json      TEXT NOT NULL,
  summary            TEXT,
  classification     TEXT,
  key_topics         TEXT,
  extracted_md       TEXT,
  content_hash       TEXT,
  last_embedded_hash TEXT,
  last_indexed       TEXT,
  last_error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_name   ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_mime   ON nodes(mime_type);
CREATE INDEX IF NOT EXISTS idx_nodes_root   ON nodes(root_id);
"#;

const UPSERT_NODE_SQL: &str = r#"
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
"#;

fn map_err(ctx: &'static str) -> impl Fn(rusqlite::Error) -> CliError {
    move |e| CliError::new(format!("{ctx}: {e}"), ErrorCode::Unknown)
}

fn collect_nodes(rows: rusqlite::Rows<'_>) -> Result<Vec<Node>, CliError> {
    let mut rows = rows;
    let mut out: Vec<Node> = Vec::new();
    while let Some(row) = rows.next().map_err(map_err("next row"))? {
        out.push(row_to_node(row).map_err(map_err("row_to_node"))?);
    }
    Ok(out)
}

fn row_to_node(row: &Row<'_>) -> rusqlite::Result<Node> {
    Ok(Node {
        id: row.get("id")?,
        parent_id: row.get("parent_id")?,
        name: row.get("name")?,
        mime_type: row.get("mime_type")?,
        size: row.get("size")?,
        modified_time: row.get("modified_time")?,
        created_time: row.get("created_time")?,
        web_view_link: row.get("web_view_link")?,
        root_id: row.get("root_id")?,
        metadata_json: row.get("metadata_json")?,
        summary: row.get("summary")?,
        classification: row.get("classification")?,
        key_topics: row.get("key_topics")?,
        extracted_md: row.get("extracted_md")?,
        content_hash: row.get("content_hash")?,
        last_embedded_hash: row.get("last_embedded_hash")?,
        last_indexed: row.get("last_indexed")?,
        last_error: row.get("last_error")?,
    })
}

// One-time `sqlite3_auto_extension` registration of sqlite-vec. Must run
// before any `Connection::open*`. Calling more than once is harmless thanks
// to `Once`.
static INIT_VEC: Once = Once::new();

// `rusqlite::ffi::sqlite3_auto_extension` is typed with SQLite's actual 3-arg
// entry-point shape (`fn(*mut sqlite3, *mut *mut c_char, *const ApiRoutines)`),
// but the `sqlite-vec` 0.1 crate re-exports its init function as a no-arg
// `unsafe extern "C" fn()` because that's how its build script sees the C
// symbol. We bridge with `transmute`, which is the pattern documented in the
// `sqlite-vec` Rust README.
type AutoExtensionFn = unsafe extern "C" fn(
    *mut rusqlite::ffi::sqlite3,
    *mut *mut std::os::raw::c_char,
    *const rusqlite::ffi::sqlite3_api_routines,
) -> std::os::raw::c_int;

#[allow(clippy::missing_transmute_annotations)]
fn ensure_vec_extension_registered() {
    INIT_VEC.call_once(|| unsafe {
        let init: unsafe extern "C" fn() = sqlite_vec::sqlite3_vec_init;
        let typed: AutoExtensionFn = std::mem::transmute(init);
        rusqlite::ffi::sqlite3_auto_extension(Some(typed));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(id: &str, parent: Option<&str>, name: &str) -> DriveNodeInput {
        DriveNodeInput {
            id: id.to_string(),
            parent_id: parent.map(str::to_string),
            name: name.to_string(),
            mime_type: "application/vnd.google-apps.folder".to_string(),
            size: None,
            modified_time: None,
            created_time: None,
            web_view_link: None,
            root_id: parent.map(|_| "root-1".to_string()),
            metadata: serde_json::Map::new(),
        }
    }

    #[test]
    fn schema_initializes_with_expected_columns() {
        let s = Store::open_in_memory().unwrap();
        let cols: Vec<String> = s
            .conn()
            .prepare("PRAGMA table_info(nodes)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for c in [
            "id",
            "parent_id",
            "name",
            "mime_type",
            "size",
            "modified_time",
            "created_time",
            "web_view_link",
            "root_id",
            "metadata_json",
            "summary",
            "classification",
            "key_topics",
            "extracted_md",
            "content_hash",
            "last_indexed",
            "last_error",
            "last_embedded_hash",
        ] {
            assert!(cols.iter().any(|n| n == c), "missing col {c}");
        }
    }

    #[test]
    fn upsert_and_get_round_trip() {
        let s = Store::open_in_memory().unwrap();
        let mut inp = input("a", None, "root");
        inp.size = Some(42);
        inp.metadata
            .insert("kind".into(), serde_json::Value::String("folder".into()));
        s.upsert_node(&inp).unwrap();

        let n = s.get_node("a").unwrap().unwrap();
        assert_eq!(n.name, "root");
        assert_eq!(n.size, Some(42));
        assert!(n.metadata_json.contains("\"kind\":\"folder\""));
        assert!(n.last_indexed.is_some());
    }

    #[test]
    fn upsert_replaces_on_conflict() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_node(&input("a", None, "first")).unwrap();
        s.upsert_node(&input("a", None, "second")).unwrap();
        assert_eq!(s.get_node("a").unwrap().unwrap().name, "second");
        assert_eq!(s.node_count().unwrap(), 1);
    }

    #[test]
    fn list_children_filters_correctly() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_node(&input("root", None, "root")).unwrap();
        s.upsert_node(&input("a", Some("root"), "alpha")).unwrap();
        s.upsert_node(&input("b", Some("root"), "beta")).unwrap();
        let kids = s.list_children(Some("root")).unwrap();
        assert_eq!(kids.len(), 2);
        assert_eq!(kids[0].name, "alpha"); // ORDER BY name ASC
        assert_eq!(kids[1].name, "beta");
        let roots = s.list_children(None).unwrap();
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].id, "root");
    }

    #[test]
    fn list_roots_groups_by_root_id() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_node(&input("root", None, "root")).unwrap();
        s.upsert_node(&input("a", Some("root"), "alpha")).unwrap();
        s.upsert_node(&input("b", Some("root"), "beta")).unwrap();
        let roots = s.list_roots().unwrap();
        // root has rootId=None, alpha+beta have rootId="root-1"
        assert_eq!(roots.len(), 2);
    }

    #[test]
    fn meta_round_trip() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.get_meta("foo").unwrap().is_none());
        s.set_meta("foo", "bar").unwrap();
        assert_eq!(s.get_meta("foo").unwrap().as_deref(), Some("bar"));
        s.set_meta("foo", "baz").unwrap();
        assert_eq!(s.get_meta("foo").unwrap().as_deref(), Some("baz"));
    }

    #[test]
    fn update_summary_clears_last_error() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_node(&input("a", None, "doc")).unwrap();
        s.record_error("a", "boom").unwrap();
        assert_eq!(
            s.get_node("a").unwrap().unwrap().last_error.as_deref(),
            Some("boom")
        );
        s.update_summary(
            "a",
            &SummaryUpdate {
                summary: "S".into(),
                classification: "doc".into(),
                key_topics: "k1,k2".into(),
                extracted_md: "# md".into(),
                content_hash: "abc".into(),
            },
        )
        .unwrap();
        let n = s.get_node("a").unwrap().unwrap();
        assert_eq!(n.summary.as_deref(), Some("S"));
        assert_eq!(n.classification.as_deref(), Some("doc"));
        assert_eq!(n.last_error, None);
    }

    #[test]
    fn search_by_name_likes_lowercase() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_node(&input("a", None, "Quarterly Report"))
            .unwrap();
        s.upsert_node(&input("b", None, "Photo Album")).unwrap();
        let hits = s.search_by_name("report", None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "a");
    }

    #[test]
    fn search_by_name_with_classification_filters() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_node(&input("a", None, "doc1")).unwrap();
        s.update_summary(
            "a",
            &SummaryUpdate {
                summary: "x".into(),
                classification: "report".into(),
                key_topics: "".into(),
                extracted_md: "".into(),
                content_hash: "".into(),
            },
        )
        .unwrap();
        s.upsert_node(&input("b", None, "doc2")).unwrap();
        let none = s.search_by_name("doc", Some("report")).unwrap();
        assert_eq!(none.len(), 1);
        assert_eq!(none[0].id, "a");
    }

    #[test]
    fn delete_nodes_with_and_without_embeddings() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_node(&input("a", None, "doc")).unwrap();
        s.delete_nodes(&["a".to_string()]).unwrap();
        assert!(s.get_node("a").unwrap().is_none());

        // With embeddings table.
        s.init_vector_table(4, false).unwrap();
        s.upsert_node(&input("b", None, "doc")).unwrap();
        s.upsert_embedding("b", &[0.1, 0.2, 0.3, 0.4]).unwrap();
        s.delete_nodes(&["b".to_string()]).unwrap();
        assert!(s.get_node("b").unwrap().is_none());
    }

    #[test]
    fn vector_table_init_idempotent_and_dim_mismatch() {
        let s = Store::open_in_memory().unwrap();
        s.init_vector_table(8, false).unwrap();
        s.init_vector_table(8, false).unwrap(); // idempotent
        let err = s.init_vector_table(16, false).unwrap_err();
        assert_eq!(err.code, ErrorCode::EmbeddingDimMismatch);
        // Rebuild lets us change dims.
        s.init_vector_table(16, true).unwrap();
        assert_eq!(s.get_meta("embedding_dims").unwrap().as_deref(), Some("16"));
    }

    #[test]
    fn upsert_embedding_and_knn_search() {
        let s = Store::open_in_memory().unwrap();
        s.init_vector_table(4, false).unwrap();
        for (id, name, v) in [
            ("a", "alpha", [1.0_f32, 0.0, 0.0, 0.0]),
            ("b", "beta", [0.0_f32, 1.0, 0.0, 0.0]),
            ("c", "gamma", [0.5_f32, 0.5, 0.0, 0.0]),
        ] {
            s.upsert_node(&input(id, None, name)).unwrap();
            s.upsert_embedding(id, &v).unwrap();
        }
        let hits = s.knn_search(&[1.0, 0.0, 0.0, 0.0], 3).unwrap();
        assert_eq!(hits.len(), 3);
        // Closest under cosine distance must be "a".
        assert_eq!(hits[0].node.id, "a");
        // Distances strictly non-decreasing.
        assert!(hits[0].distance <= hits[1].distance);
        assert!(hits[1].distance <= hits[2].distance);
    }

    #[test]
    fn upsert_embedding_replaces_on_conflict() {
        let s = Store::open_in_memory().unwrap();
        s.init_vector_table(4, false).unwrap();
        s.upsert_node(&input("a", None, "doc")).unwrap();
        s.upsert_embedding("a", &[1.0, 0.0, 0.0, 0.0]).unwrap();
        s.upsert_embedding("a", &[0.0, 1.0, 0.0, 0.0]).unwrap();
        let hits = s.knn_search(&[0.0, 1.0, 0.0, 0.0], 1).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].distance < 0.001);
    }

    #[test]
    fn batch_upsert_in_transaction() {
        let s = Store::open_in_memory().unwrap();
        let nodes: Vec<DriveNodeInput> = (0..50)
            .map(|i| input(&format!("n{i}"), None, &format!("doc{i}")))
            .collect();
        s.upsert_nodes(&nodes).unwrap();
        assert_eq!(s.node_count().unwrap(), 50);
    }

    #[test]
    fn mark_embedded_and_clear_hashes() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_node(&input("a", None, "doc")).unwrap();
        s.mark_embedded("a", "deadbeef").unwrap();
        assert_eq!(
            s.get_node("a")
                .unwrap()
                .unwrap()
                .last_embedded_hash
                .as_deref(),
            Some("deadbeef"),
        );
        s.clear_embedded_hashes_for_ids(&["a".to_string()]).unwrap();
        assert_eq!(s.get_node("a").unwrap().unwrap().last_embedded_hash, None);
    }

    #[test]
    fn clear_embedded_hashes_for_ids_only_touches_listed() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_node(&input("a", None, "alpha")).unwrap();
        s.upsert_node(&input("b", None, "beta")).unwrap();
        s.upsert_node(&input("c", None, "gamma")).unwrap();
        s.mark_embedded("a", "h-a").unwrap();
        s.mark_embedded("b", "h-b").unwrap();
        s.mark_embedded("c", "h-c").unwrap();

        s.clear_embedded_hashes_for_ids(&["a".to_string(), "b".to_string()])
            .unwrap();

        assert_eq!(s.get_node("a").unwrap().unwrap().last_embedded_hash, None);
        assert_eq!(s.get_node("b").unwrap().unwrap().last_embedded_hash, None);
        assert_eq!(
            s.get_node("c")
                .unwrap()
                .unwrap()
                .last_embedded_hash
                .as_deref(),
            Some("h-c"),
        );
    }

    #[test]
    fn clear_embedded_hashes_for_ids_empty_is_noop() {
        let s = Store::open_in_memory().unwrap();
        s.upsert_node(&input("a", None, "doc")).unwrap();
        s.mark_embedded("a", "h-a").unwrap();
        s.clear_embedded_hashes_for_ids(&[]).unwrap();
        assert_eq!(
            s.get_node("a")
                .unwrap()
                .unwrap()
                .last_embedded_hash
                .as_deref(),
            Some("h-a"),
        );
    }

    #[test]
    fn clear_embeddings_drops_table_and_meta() {
        let s = Store::open_in_memory().unwrap();
        s.init_vector_table(4, false).unwrap();
        assert!(s.has_vector_table().unwrap());
        s.clear_embeddings().unwrap();
        assert!(!s.has_vector_table().unwrap());
    }
}

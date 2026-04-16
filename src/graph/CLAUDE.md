# Graph Store

## SQLite Setup

Bun's bundled SQLite lacks extension-loading support. `sqlite-native.ts` calls `Database.setCustomSQLite()` once (global, one-shot) before any `new Database()` to point at a system SQLite with extension support:

- macOS: `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`
- Linux: `libsqlite3.so.0`
- Override: `GDRIVESCOPE_SQLITE_LIB` env var

## Schema

Single `nodes` table (schema v3) with columns: id, parent_id, name, mime_type, size, modified_time, created_time, web_view_link, root_id, metadata_json, summary, classification, key_topics, extracted_md, content_hash, last_indexed, last_error.

Migrations are additive: `ALTER TABLE ADD COLUMN` guarded by `hasColumn()`. Version tracked in `meta` table.

## Vector Table

`embeddings` is a `vec0` virtual table (sqlite-vec). Created lazily by `initVectorTable(dimensions)`. Key constraints:

- **No UPSERT**: vec0 does not support `INSERT ... ON CONFLICT`. Upsert is DELETE + INSERT.
- **Lazy statements**: Embedding prepared statements are created on first use because the virtual table may not exist yet.
- **Dimension mismatch is fatal**: Switching embedding providers requires `--rebuild-embeddings` to drop and recreate the table.

## Store Interface

`openStore(path)` returns a closure-based `Store` object (not a class). All prepared statements are scoped inside the closure. Always call `store.close()` when done.

## Graphology

`hydrateGraph()` loads all nodes into a `DirectedGraph`. Edges are implicit — derived from `parent_id` at hydration time, not stored as separate rows. The graph is read-only after hydration; mutations go through `Store` methods, not graphology.

//! SQLite + sqlite-vec store. Ported from `src/graph/store.ts` (and replacing
//! the deleted `src/graph/sqlite-native.ts`) in Phase 2 via
//! `rusqlite` (bundled feature) + `sqlite-vec`. Schema DDL must match the
//! TS version exactly so existing `~/.config/gdrivescope/drive.db` files
//! open correctly.

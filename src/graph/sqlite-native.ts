import { Database } from 'bun:sqlite';

// Bun's bundled SQLite is compiled WITHOUT extension-loading support, so
// `sqlite-vec` cannot be loaded against it. Point Bun at a system SQLite
// that does support loadExtension. `setCustomSQLite` mutates a global Bun
// state — it must be called exactly once, before the first `new Database()`.
let applied = false;

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

export function ensureExtensionCapableSqlite(): void {
  if (applied) return;
  const path = resolveCustomSqlitePath();
  if (path) {
    Database.setCustomSQLite(path);
  }
  applied = true;
}

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriveNodeInput } from '../../src/graph/model.js';
import { openStore } from '../../src/graph/store.js';

export interface TempDbContext {
  dbPath: string;
  tmpDir: string;
  cleanup(): void;
}

export function useTempDb(prefix: string): TempDbContext {
  const tmpDir = mkdtempSync(join(tmpdir(), `gdrivescope-${prefix}-`));
  const dbPath = join(tmpDir, 'drive.db');
  Bun.env.GDRIVESCOPE_DB = dbPath;
  return {
    dbPath,
    tmpDir,
    cleanup() {
      delete Bun.env.GDRIVESCOPE_DB;
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

export function seedTempDb(dbPath: string, nodes: DriveNodeInput[]): void {
  const store = openStore(dbPath);
  try {
    for (const n of nodes) store.upsertNode(n);
  } finally {
    store.close();
  }
}

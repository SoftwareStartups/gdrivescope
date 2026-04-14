import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir(): string {
  const home = Bun.env.HOME ?? homedir();
  return join(home, '.config', 'gdrivescope');
}

export function configPath(): string {
  return join(configDir(), 'config.toml');
}

export async function ensureConfigDir(): Promise<string> {
  const dir = configDir();
  await mkdir(dir, { recursive: true });
  return dir;
}

export function getDbPath(): string {
  const override = Bun.env.GDRIVESCOPE_DB;
  if (override) return override;
  return join(configDir(), 'drive.db');
}

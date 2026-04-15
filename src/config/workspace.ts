import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { configPath as defaultConfigPath } from '../utils/config.js';

export interface ConfigRoot {
  id: string;
  label?: string;
}

export interface WorkspaceConfig {
  roots: ConfigRoot[];
  folders: Record<string, string>;
}

export const EMPTY_WORKSPACE_CONFIG: WorkspaceConfig = Object.freeze({
  roots: [],
  folders: {},
}) as WorkspaceConfig;

function resolveConfigPath(path?: string): string {
  return path ?? Bun.env.GDRIVESCOPE_CONFIG ?? defaultConfigPath();
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRoots(raw: unknown): ConfigRoot[] {
  if (!Array.isArray(raw)) return [];
  const roots: ConfigRoot[] = [];
  for (const entry of raw) {
    if (!isStringRecord(entry)) continue;
    const id = entry.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    const label = typeof entry.label === 'string' ? entry.label : undefined;
    roots.push(label ? { id, label } : { id });
  }
  return roots;
}

function parseFolders(raw: unknown): Record<string, string> {
  if (!isStringRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.length > 0) {
      out[name] = value;
    }
  }
  return out;
}

export async function loadWorkspaceConfig(
  path?: string
): Promise<WorkspaceConfig> {
  const target = resolveConfigPath(path);
  const file = Bun.file(target);
  if (!(await file.exists())) {
    return { roots: [], folders: {} };
  }
  const text = await file.text();
  if (text.trim().length === 0) {
    return { roots: [], folders: {} };
  }
  const parsed = parse(text) as Record<string, unknown>;
  return {
    roots: parseRoots(parsed.roots),
    folders: parseFolders(parsed.folders),
  };
}

export async function saveWorkspaceConfig(
  cfg: WorkspaceConfig,
  path?: string
): Promise<string> {
  const target = resolveConfigPath(path);
  mkdirSync(dirname(target), { recursive: true });
  const payload: Record<string, unknown> = {};
  if (cfg.roots.length > 0) {
    payload.roots = cfg.roots.map((r) =>
      r.label ? { id: r.id, label: r.label } : { id: r.id }
    );
  }
  if (Object.keys(cfg.folders).length > 0) {
    payload.folders = cfg.folders;
  }
  const body =
    Object.keys(payload).length === 0
      ? '# gdrivescope config\n'
      : `# gdrivescope config\n\n${stringify(payload)}\n`;
  await Bun.write(target, body);
  return target;
}

export function resolveFolder(cfg: WorkspaceConfig, nameOrId: string): string {
  return cfg.folders[nameOrId] ?? nameOrId;
}

export function findRoot(
  cfg: WorkspaceConfig,
  id: string
): ConfigRoot | undefined {
  return cfg.roots.find((r) => r.id === id);
}

export function upsertRoot(
  cfg: WorkspaceConfig,
  root: ConfigRoot
): WorkspaceConfig {
  const existing = cfg.roots.findIndex((r) => r.id === root.id);
  const roots = [...cfg.roots];
  if (existing >= 0) {
    roots[existing] = root;
  } else {
    roots.push(root);
  }
  return { ...cfg, roots };
}

export function removeRoot(cfg: WorkspaceConfig, id: string): WorkspaceConfig {
  return { ...cfg, roots: cfg.roots.filter((r) => r.id !== id) };
}

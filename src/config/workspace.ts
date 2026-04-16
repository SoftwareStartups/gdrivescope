import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { configPath as defaultConfigPath } from '../utils/config.js';

export interface ConfigRoot {
  id: string;
  label?: string;
}

export interface LlmConfig {
  provider?: string;
}

export interface EmbeddingConfig {
  provider?: string;
}

export interface OllamaConfig {
  host?: string;
  llmModel?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
}

export interface ExtractionConfig {
  maxSizeBytes?: number;
  maxPdfPages?: number;
}

export interface WorkspaceConfig {
  roots: ConfigRoot[];
  folders: Record<string, string>;
  llm?: LlmConfig;
  embedding?: EmbeddingConfig;
  extraction?: ExtractionConfig;
  ollama?: OllamaConfig;
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

function parseLlm(raw: unknown): LlmConfig | undefined {
  if (!isStringRecord(raw)) return undefined;
  const provider = typeof raw.provider === 'string' ? raw.provider : undefined;
  return provider ? { provider } : undefined;
}

function parseEmbedding(raw: unknown): EmbeddingConfig | undefined {
  if (!isStringRecord(raw)) return undefined;
  const provider = typeof raw.provider === 'string' ? raw.provider : undefined;
  return provider ? { provider } : undefined;
}

function parseOllama(raw: unknown): OllamaConfig | undefined {
  if (!isStringRecord(raw)) return undefined;
  const out: OllamaConfig = {};
  if (typeof raw.host === 'string') out.host = raw.host;
  if (typeof raw.llm_model === 'string') out.llmModel = raw.llm_model;
  if (typeof raw.embedding_model === 'string')
    out.embeddingModel = raw.embedding_model;
  if (typeof raw.embedding_dimensions === 'number')
    out.embeddingDimensions = raw.embedding_dimensions;
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseExtraction(raw: unknown): ExtractionConfig | undefined {
  if (!isStringRecord(raw)) return undefined;
  const out: ExtractionConfig = {};
  if (typeof raw.max_size_bytes === 'number') {
    out.maxSizeBytes = raw.max_size_bytes;
  }
  if (typeof raw.max_pdf_pages === 'number') {
    out.maxPdfPages = raw.max_pdf_pages;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
  const cfg: WorkspaceConfig = {
    roots: parseRoots(parsed.roots),
    folders: parseFolders(parsed.folders),
  };
  const llm = parseLlm(parsed.llm);
  if (llm) cfg.llm = llm;
  const embedding = parseEmbedding(parsed.embedding);
  if (embedding) cfg.embedding = embedding;
  const extraction = parseExtraction(parsed.extraction);
  if (extraction) cfg.extraction = extraction;
  const ollama = parseOllama(parsed.ollama);
  if (ollama) cfg.ollama = ollama;
  return cfg;
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
  if (cfg.llm?.provider) {
    payload.llm = { provider: cfg.llm.provider };
  }
  if (cfg.embedding?.provider) {
    payload.embedding = { provider: cfg.embedding.provider };
  }
  if (cfg.extraction) {
    const e: Record<string, unknown> = {};
    if (cfg.extraction.maxSizeBytes !== undefined) {
      e.max_size_bytes = cfg.extraction.maxSizeBytes;
    }
    if (cfg.extraction.maxPdfPages !== undefined) {
      e.max_pdf_pages = cfg.extraction.maxPdfPages;
    }
    if (Object.keys(e).length > 0) payload.extraction = e;
  }
  if (cfg.ollama) {
    const o: Record<string, unknown> = {};
    if (cfg.ollama.host !== undefined) o.host = cfg.ollama.host;
    if (cfg.ollama.llmModel !== undefined) o.llm_model = cfg.ollama.llmModel;
    if (cfg.ollama.embeddingModel !== undefined)
      o.embedding_model = cfg.ollama.embeddingModel;
    if (cfg.ollama.embeddingDimensions !== undefined)
      o.embedding_dimensions = cfg.ollama.embeddingDimensions;
    if (Object.keys(o).length > 0) payload.ollama = o;
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

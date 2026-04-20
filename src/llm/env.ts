import { CliError } from '../utils/errors.js';

export type LlmProviderName =
  | 'anthropic'
  | 'openai'
  | 'azure-openai'
  | 'ollama';

export type EmbeddingProviderName =
  | 'openai'
  | 'azure-openai'
  | 'voyage'
  | 'ollama';

const LLM_MODEL_ENV: Record<LlmProviderName, string> = {
  anthropic: 'GDRIVESCOPE_ANTHROPIC_MODEL',
  openai: 'GDRIVESCOPE_OPENAI_MODEL',
  'azure-openai': 'GDRIVESCOPE_AZURE_OPENAI_MODEL',
  ollama: 'GDRIVESCOPE_OLLAMA_MODEL',
};

const EMBEDDING_MODEL_ENV: Record<EmbeddingProviderName, string> = {
  openai: 'GDRIVESCOPE_OPENAI_EMBEDDING_MODEL',
  'azure-openai': 'GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_MODEL',
  voyage: 'GDRIVESCOPE_VOYAGE_EMBEDDING_MODEL',
  ollama: 'GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL',
};

const EMBEDDING_DIMS_ENV: Record<EmbeddingProviderName, string> = {
  openai: 'GDRIVESCOPE_OPENAI_EMBEDDING_DIMENSIONS',
  'azure-openai': 'GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_DIMENSIONS',
  voyage: 'GDRIVESCOPE_VOYAGE_EMBEDDING_DIMENSIONS',
  ollama: 'GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS',
};

export function readLlmModelEnv(name: LlmProviderName): string | undefined {
  return Bun.env[LLM_MODEL_ENV[name]];
}

export function readEmbeddingModelEnv(
  name: EmbeddingProviderName
): string | undefined {
  return Bun.env[EMBEDDING_MODEL_ENV[name]];
}

export function parseDimsEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new CliError(
      `Invalid embedding dimensions env var value: ${raw}`,
      'BAD_ARG'
    );
  }
  return n;
}

export function readEmbeddingDimsEnv(
  name: EmbeddingProviderName
): number | undefined {
  return parseDimsEnv(Bun.env[EMBEDDING_DIMS_ENV[name]]);
}

export function requireEnv(name: string, hint: string): string {
  const v = Bun.env[name];
  if (!v) {
    throw new CliError(`${name} is not set. ${hint}`, 'PROVIDER_UNCONFIGURED');
  }
  return v;
}

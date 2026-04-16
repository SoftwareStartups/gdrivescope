import type { OllamaConfig } from '../config/workspace.js';
import { CliError } from '../utils/errors.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { OllamaEmbeddingProvider } from './ollama-embedding.js';
import { OpenaiEmbeddingProvider } from './openai-embedding.js';
import { VoyageEmbeddingProvider } from './voyage-embedding.js';

export type EmbeddingProviderName = 'openai' | 'voyage' | 'ollama';

export interface ResolveEmbeddingOptions {
  flagProvider?: string;
  configProvider?: string;
  ollamaConfig?: OllamaConfig;
}

const KNOWN: ReadonlySet<EmbeddingProviderName> = new Set([
  'openai',
  'voyage',
  'ollama',
]);

function isKnown(name: string): name is EmbeddingProviderName {
  return (KNOWN as ReadonlySet<string>).has(name);
}

export function resolveEmbeddingProvider(
  opts: ResolveEmbeddingOptions
): EmbeddingProvider {
  const raw =
    opts.flagProvider ??
    Bun.env.GDRIVESCOPE_EMBEDDING_PROVIDER ??
    opts.configProvider ??
    'openai';
  const name = raw.toLowerCase();

  if (!isKnown(name)) {
    throw new CliError(
      `Unknown embedding provider: ${raw}`,
      'PROVIDER_UNKNOWN'
    );
  }

  if (name === 'openai') {
    const key = Bun.env.OPENAI_API_KEY;
    if (!key) {
      throw new CliError(
        'OPENAI_API_KEY is not set. Export it or pass --embedding-provider with a different provider.',
        'PROVIDER_UNCONFIGURED'
      );
    }
    return new OpenaiEmbeddingProvider(key);
  }

  if (name === 'voyage') {
    const key = Bun.env.VOYAGE_API_KEY;
    if (!key) {
      throw new CliError(
        'VOYAGE_API_KEY is not set. Export it or pass --embedding-provider with a different provider.',
        'PROVIDER_UNCONFIGURED'
      );
    }
    return new VoyageEmbeddingProvider(key);
  }

  // name === 'ollama' — no API key required, local service
  const host =
    Bun.env.GDRIVESCOPE_OLLAMA_HOST ??
    opts.ollamaConfig?.host ??
    'http://localhost:11434';
  const model =
    Bun.env.GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL ??
    opts.ollamaConfig?.embeddingModel ??
    'nomic-embed-text';
  const dimensions =
    Number(Bun.env.GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS) ||
    opts.ollamaConfig?.embeddingDimensions ||
    768;
  return new OllamaEmbeddingProvider({ host, model, dimensions });
}

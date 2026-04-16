import type { AzureConfig, OllamaConfig } from '../config/workspace.js';
import { CliError } from '../utils/errors.js';
import { info } from '../utils/logging.js';
import { AzureOpenaiEmbeddingProvider } from './azure-openai-embedding.js';
import type { EmbeddingProvider } from './embedding-provider.js';
import { OllamaEmbeddingProvider } from './ollama-embedding.js';
import { OpenaiEmbeddingProvider } from './openai-embedding.js';
import { VoyageEmbeddingProvider } from './voyage-embedding.js';

export type EmbeddingProviderName =
  | 'openai'
  | 'azure-openai'
  | 'voyage'
  | 'ollama';

export interface ResolveEmbeddingOptions {
  flagProvider?: string;
  configProvider?: string;
  configModel?: string;
  ollamaConfig?: OllamaConfig;
  azureConfig?: AzureConfig;
}

const KNOWN: ReadonlySet<EmbeddingProviderName> = new Set([
  'openai',
  'azure-openai',
  'voyage',
  'ollama',
]);

function isKnown(name: string): name is EmbeddingProviderName {
  return (KNOWN as ReadonlySet<string>).has(name);
}

function inferEmbeddingProvider(
  opts: ResolveEmbeddingOptions
): EmbeddingProviderName | undefined {
  if (Bun.env.OPENAI_API_KEY) return 'openai';
  if (Bun.env.AZURE_OPENAI_API_KEY && Bun.env.AZURE_OPENAI_ENDPOINT)
    return 'azure-openai';
  if (Bun.env.VOYAGE_API_KEY) return 'voyage';
  if (opts.ollamaConfig) return 'ollama';
  return undefined;
}

function resolveModel(
  name: EmbeddingProviderName,
  configModel?: string
): string | undefined {
  const envModel = {
    openai: Bun.env.GDRIVESCOPE_OPENAI_EMBEDDING_MODEL,
    'azure-openai': Bun.env.GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_MODEL,
    voyage: Bun.env.GDRIVESCOPE_VOYAGE_MODEL,
    ollama: Bun.env.GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL,
  }[name];
  return envModel ?? configModel ?? undefined;
}

export function resolveEmbeddingProvider(
  opts: ResolveEmbeddingOptions
): EmbeddingProvider {
  const explicit =
    opts.flagProvider ??
    Bun.env.GDRIVESCOPE_EMBEDDING_PROVIDER ??
    opts.configProvider;

  let name: string;
  if (explicit) {
    name = explicit.toLowerCase();
  } else {
    const inferred = inferEmbeddingProvider(opts);
    if (!inferred) {
      throw new CliError(
        'No embedding provider configured. Set OPENAI_API_KEY, ' +
          'AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT, or VOYAGE_API_KEY, ' +
          'or configure [embedding] provider in config.toml.',
        'PROVIDER_UNCONFIGURED'
      );
    }
    name = inferred;
    info(`Auto-selected embedding provider: ${name}`);
  }

  if (!isKnown(name)) {
    throw new CliError(
      `Unknown embedding provider: ${name}`,
      'PROVIDER_UNKNOWN'
    );
  }

  const model = resolveModel(name, opts.configModel);

  if (name === 'openai') {
    const key = Bun.env.OPENAI_API_KEY;
    if (!key) {
      throw new CliError(
        'OPENAI_API_KEY is not set. Export it or pass --embedding-provider with a different provider.',
        'PROVIDER_UNCONFIGURED'
      );
    }
    return new OpenaiEmbeddingProvider({ apiKey: key, model });
  }

  if (name === 'azure-openai') {
    const apiKey = Bun.env.AZURE_OPENAI_API_KEY;
    if (!apiKey) {
      throw new CliError(
        'AZURE_OPENAI_API_KEY is not set. Export it or pass --embedding-provider with a different provider.',
        'PROVIDER_UNCONFIGURED'
      );
    }
    const endpoint =
      Bun.env.AZURE_OPENAI_ENDPOINT ?? opts.azureConfig?.endpoint;
    if (!endpoint) {
      throw new CliError(
        'AZURE_OPENAI_ENDPOINT is not set. Export it or add endpoint to [azure] in config.toml.',
        'PROVIDER_UNCONFIGURED'
      );
    }
    const deployment =
      Bun.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ??
      opts.azureConfig?.embeddingDeployment;
    const apiVersion =
      Bun.env.AZURE_OPENAI_API_VERSION ?? opts.azureConfig?.apiVersion;
    return new AzureOpenaiEmbeddingProvider({
      apiKey,
      endpoint,
      apiVersion,
      deployment,
      model,
    });
  }

  if (name === 'voyage') {
    const key = Bun.env.VOYAGE_API_KEY;
    if (!key) {
      throw new CliError(
        'VOYAGE_API_KEY is not set. Export it or pass --embedding-provider with a different provider.',
        'PROVIDER_UNCONFIGURED'
      );
    }
    return new VoyageEmbeddingProvider({ apiKey: key, model });
  }

  // name === 'ollama' — no API key required, local service
  const host =
    Bun.env.GDRIVESCOPE_OLLAMA_HOST ??
    opts.ollamaConfig?.host ??
    'http://localhost:11434';
  const ollamaModel =
    model ?? opts.ollamaConfig?.embeddingModel ?? 'nomic-embed-text';
  const dimensions =
    Number(Bun.env.GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS) ||
    opts.ollamaConfig?.embeddingDimensions ||
    768;
  return new OllamaEmbeddingProvider({
    host,
    model: ollamaModel,
    dimensions,
  });
}

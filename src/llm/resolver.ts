import type { AzureConfig, OllamaConfig } from '../config/workspace.js';
import { CliError } from '../utils/errors.js';
import { info } from '../utils/logging.js';
import { AnthropicProvider } from './anthropic.js';
import { AzureOpenaiProvider } from './azure-openai.js';
import { OllamaProvider } from './ollama.js';
import { OpenaiProvider } from './openai.js';
import type { LlmProvider } from './provider.js';

export type LlmProviderName =
  | 'anthropic'
  | 'openai'
  | 'azure-openai'
  | 'ollama';

export interface ResolveLlmOptions {
  flagProvider?: string;
  configProvider?: string;
  configModel?: string;
  ollamaConfig?: OllamaConfig;
  azureConfig?: AzureConfig;
}

const KNOWN: ReadonlySet<LlmProviderName> = new Set([
  'anthropic',
  'openai',
  'azure-openai',
  'ollama',
]);

function isKnown(name: string): name is LlmProviderName {
  return (KNOWN as ReadonlySet<string>).has(name);
}

function inferLlmProvider(
  opts: ResolveLlmOptions
): LlmProviderName | undefined {
  if (Bun.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (Bun.env.OPENAI_API_KEY) return 'openai';
  if (Bun.env.AZURE_OPENAI_API_KEY && Bun.env.AZURE_OPENAI_ENDPOINT)
    return 'azure-openai';
  if (opts.ollamaConfig) return 'ollama';
  return undefined;
}

function resolveModel(
  name: LlmProviderName,
  configModel?: string
): string | undefined {
  const envModel = {
    anthropic: Bun.env.GDRIVESCOPE_ANTHROPIC_MODEL,
    openai: Bun.env.GDRIVESCOPE_OPENAI_MODEL,
    'azure-openai': Bun.env.GDRIVESCOPE_AZURE_OPENAI_MODEL,
    ollama: Bun.env.GDRIVESCOPE_OLLAMA_MODEL,
  }[name];
  return envModel ?? configModel ?? undefined;
}

export function resolveLlmProvider(opts: ResolveLlmOptions): LlmProvider {
  const explicit =
    opts.flagProvider ??
    Bun.env.GDRIVESCOPE_LLM_PROVIDER ??
    opts.configProvider;

  let name: string;
  if (explicit) {
    name = explicit.toLowerCase();
  } else {
    const inferred = inferLlmProvider(opts);
    if (!inferred) {
      throw new CliError(
        'No LLM provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, ' +
          'or AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT, or configure ' +
          '[llm] provider in config.toml.',
        'PROVIDER_UNCONFIGURED'
      );
    }
    name = inferred;
    info(`Auto-selected LLM provider: ${name}`);
  }

  if (!isKnown(name)) {
    throw new CliError(`Unknown LLM provider: ${name}`, 'PROVIDER_UNKNOWN');
  }

  const model = resolveModel(name, opts.configModel);

  if (name === 'anthropic') {
    const key = Bun.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new CliError(
        'ANTHROPIC_API_KEY is not set. Export it or pass --provider with a different provider.',
        'PROVIDER_UNCONFIGURED'
      );
    }
    return new AnthropicProvider({ apiKey: key, model });
  }

  if (name === 'openai') {
    const key = Bun.env.OPENAI_API_KEY;
    if (!key) {
      throw new CliError(
        'OPENAI_API_KEY is not set. Export it or pass --provider with a different provider.',
        'PROVIDER_UNCONFIGURED'
      );
    }
    return new OpenaiProvider({ apiKey: key, model });
  }

  if (name === 'azure-openai') {
    const apiKey = Bun.env.AZURE_OPENAI_API_KEY;
    if (!apiKey) {
      throw new CliError(
        'AZURE_OPENAI_API_KEY is not set. Export it or pass --provider with a different provider.',
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
      Bun.env.AZURE_OPENAI_LLM_DEPLOYMENT ?? opts.azureConfig?.llmDeployment;
    const apiVersion =
      Bun.env.AZURE_OPENAI_API_VERSION ?? opts.azureConfig?.apiVersion;
    return new AzureOpenaiProvider({
      apiKey,
      endpoint,
      apiVersion,
      deployment,
      model,
    });
  }

  // name === 'ollama' — no API key required, local service
  const host =
    Bun.env.GDRIVESCOPE_OLLAMA_HOST ??
    opts.ollamaConfig?.host ??
    'http://localhost:11434';
  const ollamaModel =
    model ?? opts.ollamaConfig?.llmModel ?? 'llama3.2:3b-instruct';
  return new OllamaProvider({ host, model: ollamaModel });
}

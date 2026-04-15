import { CliError } from '../utils/errors.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenaiProvider } from './openai.js';
import type { LlmProvider } from './provider.js';

export type LlmProviderName = 'anthropic' | 'openai' | 'ollama';

export interface ResolveLlmOptions {
  flagProvider?: string;
  configProvider?: string;
}

const KNOWN: ReadonlySet<LlmProviderName> = new Set([
  'anthropic',
  'openai',
  'ollama',
]);

function isKnown(name: string): name is LlmProviderName {
  return (KNOWN as ReadonlySet<string>).has(name);
}

export function resolveLlmProvider(opts: ResolveLlmOptions): LlmProvider {
  const raw =
    opts.flagProvider ??
    Bun.env.GDRIVESCOPE_LLM_PROVIDER ??
    opts.configProvider ??
    'anthropic';
  const name = raw.toLowerCase();

  if (!isKnown(name)) {
    throw new CliError(`Unknown LLM provider: ${raw}`, 'PROVIDER_UNKNOWN');
  }

  if (name === 'anthropic') {
    const key = Bun.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new CliError(
        'ANTHROPIC_API_KEY is not set. Export it or pass --provider with a different provider.',
        'PROVIDER_UNCONFIGURED'
      );
    }
    return new AnthropicProvider(key);
  }

  if (name === 'openai') {
    const key = Bun.env.OPENAI_API_KEY;
    if (!key) {
      throw new CliError(
        'OPENAI_API_KEY is not set. Export it or pass --provider with a different provider.',
        'PROVIDER_UNCONFIGURED'
      );
    }
    return new OpenaiProvider(key);
  }

  // name === 'ollama' — overlay plan in docs/plans/ollama-provider.md replaces this.
  throw new CliError(
    'Ollama provider is not compiled into this build. See docs/plans/ollama-provider.md.',
    'PROVIDER_UNAVAILABLE'
  );
}

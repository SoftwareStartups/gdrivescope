import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveLlmProvider } from '../../src/llm/resolver.js';
import { CliError } from '../../src/utils/errors.js';
import { useEnvGuard } from '../helpers/envGuard.js';

const guard = useEnvGuard([
  'GDRIVESCOPE_LLM_PROVIDER',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GDRIVESCOPE_OLLAMA_HOST',
  'GDRIVESCOPE_OLLAMA_MODEL',
]);

describe('resolveLlmProvider', () => {
  beforeEach(() => guard.setup());
  afterEach(() => guard.teardown());

  test('default resolves to anthropic when ANTHROPIC_API_KEY is set', () => {
    Bun.env.ANTHROPIC_API_KEY = 'sk-ant-fake';
    const p = resolveLlmProvider({});
    expect(p.name).toBe('anthropic');
  });

  test('default with no key throws PROVIDER_UNCONFIGURED', () => {
    try {
      resolveLlmProvider({});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('PROVIDER_UNCONFIGURED');
    }
  });

  test('flag beats env', () => {
    Bun.env.GDRIVESCOPE_LLM_PROVIDER = 'anthropic';
    Bun.env.ANTHROPIC_API_KEY = 'a';
    Bun.env.OPENAI_API_KEY = 'o';
    const p = resolveLlmProvider({ flagProvider: 'openai' });
    expect(p.name).toBe('openai');
  });

  test('env beats config', () => {
    Bun.env.GDRIVESCOPE_LLM_PROVIDER = 'openai';
    Bun.env.ANTHROPIC_API_KEY = 'a';
    Bun.env.OPENAI_API_KEY = 'o';
    const p = resolveLlmProvider({ configProvider: 'anthropic' });
    expect(p.name).toBe('openai');
  });

  test('config falls through when no flag/env', () => {
    Bun.env.ANTHROPIC_API_KEY = 'a';
    Bun.env.OPENAI_API_KEY = 'o';
    const p = resolveLlmProvider({ configProvider: 'openai' });
    expect(p.name).toBe('openai');
  });

  test('missing OPENAI_API_KEY throws PROVIDER_UNCONFIGURED', () => {
    try {
      resolveLlmProvider({ flagProvider: 'openai' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('PROVIDER_UNCONFIGURED');
    }
  });

  test('unknown provider throws PROVIDER_UNKNOWN', () => {
    try {
      resolveLlmProvider({ flagProvider: 'bogus' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('PROVIDER_UNKNOWN');
    }
  });

  test('ollama resolves without API key', () => {
    const p = resolveLlmProvider({ flagProvider: 'ollama' });
    expect(p.name).toBe('ollama');
  });

  test('provider name comparison is case-insensitive', () => {
    Bun.env.OPENAI_API_KEY = 'o';
    const p = resolveLlmProvider({ flagProvider: 'OpenAI' });
    expect(p.name).toBe('openai');
  });
});

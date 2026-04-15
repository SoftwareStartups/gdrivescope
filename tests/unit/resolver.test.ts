import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveLlmProvider } from '../../src/llm/resolver.js';
import { CliError } from '../../src/utils/errors.js';

const ENV_KEYS = [
  'GDRIVESCOPE_LLM_PROVIDER',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const;

describe('resolveLlmProvider', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = Bun.env[k];
      delete Bun.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete Bun.env[k];
      else Bun.env[k] = saved[k];
    }
  });

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

  test('ollama is reported unavailable until overlay lands', () => {
    try {
      resolveLlmProvider({ flagProvider: 'ollama' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('PROVIDER_UNAVAILABLE');
    }
  });

  test('provider name comparison is case-insensitive', () => {
    Bun.env.OPENAI_API_KEY = 'o';
    const p = resolveLlmProvider({ flagProvider: 'OpenAI' });
    expect(p.name).toBe('openai');
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveLlmProvider } from '../../src/llm/llm-resolver.js';
import { CliError } from '../../src/utils/errors.js';
import { useEnvGuard } from '../helpers/envGuard.js';

const guard = useEnvGuard([
  'GDRIVESCOPE_LLM_PROVIDER',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_LLM_DEPLOYMENT',
  'GDRIVESCOPE_OLLAMA_HOST',
  'GDRIVESCOPE_OLLAMA_MODEL',
  'GDRIVESCOPE_ANTHROPIC_MODEL',
  'GDRIVESCOPE_OPENAI_MODEL',
  'GDRIVESCOPE_AZURE_OPENAI_MODEL',
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

  describe('azure-openai', () => {
    test('resolves when key and endpoint are set', () => {
      Bun.env.AZURE_OPENAI_API_KEY = 'az-key';
      Bun.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      const p = resolveLlmProvider({ flagProvider: 'azure-openai' });
      expect(p.name).toBe('azure-openai');
    });

    test('missing key throws PROVIDER_UNCONFIGURED', () => {
      Bun.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      try {
        resolveLlmProvider({ flagProvider: 'azure-openai' });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe('PROVIDER_UNCONFIGURED');
      }
    });

    test('missing endpoint throws PROVIDER_UNCONFIGURED', () => {
      Bun.env.AZURE_OPENAI_API_KEY = 'az-key';
      try {
        resolveLlmProvider({ flagProvider: 'azure-openai' });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe('PROVIDER_UNCONFIGURED');
      }
    });

    test('endpoint from azureConfig when env not set', () => {
      Bun.env.AZURE_OPENAI_API_KEY = 'az-key';
      const p = resolveLlmProvider({
        flagProvider: 'azure-openai',
        azureConfig: { endpoint: 'https://cfg.openai.azure.com' },
      });
      expect(p.name).toBe('azure-openai');
    });
  });

  describe('inference', () => {
    test('selects anthropic when ANTHROPIC_API_KEY is set', () => {
      Bun.env.ANTHROPIC_API_KEY = 'a';
      const p = resolveLlmProvider({});
      expect(p.name).toBe('anthropic');
    });

    test('selects openai when only OPENAI_API_KEY is set', () => {
      Bun.env.OPENAI_API_KEY = 'o';
      const p = resolveLlmProvider({});
      expect(p.name).toBe('openai');
    });

    test('selects azure-openai when only Azure keys are set', () => {
      Bun.env.AZURE_OPENAI_API_KEY = 'az-key';
      Bun.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      const p = resolveLlmProvider({});
      expect(p.name).toBe('azure-openai');
    });

    test('selects ollama when ollamaConfig provided and no keys', () => {
      const p = resolveLlmProvider({
        ollamaConfig: { host: 'http://localhost:11434' },
      });
      expect(p.name).toBe('ollama');
    });

    test('throws when no keys and no ollamaConfig', () => {
      try {
        resolveLlmProvider({});
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe('PROVIDER_UNCONFIGURED');
      }
    });

    test('anthropic wins over openai when both keys set', () => {
      Bun.env.ANTHROPIC_API_KEY = 'a';
      Bun.env.OPENAI_API_KEY = 'o';
      const p = resolveLlmProvider({});
      expect(p.name).toBe('anthropic');
    });

    test('explicit provider skips inference', () => {
      Bun.env.ANTHROPIC_API_KEY = 'a';
      Bun.env.OPENAI_API_KEY = 'o';
      const p = resolveLlmProvider({ flagProvider: 'openai' });
      expect(p.name).toBe('openai');
    });
  });
});

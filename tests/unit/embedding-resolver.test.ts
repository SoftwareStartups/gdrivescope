import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveEmbeddingProvider } from '../../src/llm/embedding-resolver.js';
import { CliError } from '../../src/utils/errors.js';
import { useEnvGuard } from '../helpers/envGuard.js';

const guard = useEnvGuard([
  'GDRIVESCOPE_EMBEDDING_PROVIDER',
  'OPENAI_API_KEY',
  'VOYAGE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_EMBEDDING_DEPLOYMENT',
  'GDRIVESCOPE_OLLAMA_HOST',
  'GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL',
  'GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS',
  'GDRIVESCOPE_OPENAI_EMBEDDING_MODEL',
  'GDRIVESCOPE_OPENAI_EMBEDDING_DIMENSIONS',
  'GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_MODEL',
  'GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_DIMENSIONS',
  'GDRIVESCOPE_VOYAGE_MODEL',
  'GDRIVESCOPE_VOYAGE_EMBEDDING_DIMENSIONS',
]);

describe('resolveEmbeddingProvider', () => {
  beforeEach(() => guard.setup());
  afterEach(() => guard.teardown());

  test('default resolves to openai when OPENAI_API_KEY is set', () => {
    Bun.env.OPENAI_API_KEY = 'o';
    const p = resolveEmbeddingProvider({});
    expect(p.name).toBe('openai');
    expect(p.dimensions).toBe(1536);
  });

  test('default with no key throws PROVIDER_UNCONFIGURED', () => {
    try {
      resolveEmbeddingProvider({});
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('PROVIDER_UNCONFIGURED');
    }
  });

  test('flag beats env', () => {
    Bun.env.GDRIVESCOPE_EMBEDDING_PROVIDER = 'openai';
    Bun.env.OPENAI_API_KEY = 'o';
    Bun.env.VOYAGE_API_KEY = 'v';
    const p = resolveEmbeddingProvider({ flagProvider: 'voyage' });
    expect(p.name).toBe('voyage');
    expect(p.dimensions).toBe(512);
  });

  test('env beats config', () => {
    Bun.env.GDRIVESCOPE_EMBEDDING_PROVIDER = 'voyage';
    Bun.env.OPENAI_API_KEY = 'o';
    Bun.env.VOYAGE_API_KEY = 'v';
    const p = resolveEmbeddingProvider({ configProvider: 'openai' });
    expect(p.name).toBe('voyage');
  });

  test('config falls through when no flag/env', () => {
    Bun.env.OPENAI_API_KEY = 'o';
    Bun.env.VOYAGE_API_KEY = 'v';
    const p = resolveEmbeddingProvider({ configProvider: 'voyage' });
    expect(p.name).toBe('voyage');
  });

  test('missing VOYAGE_API_KEY throws PROVIDER_UNCONFIGURED', () => {
    try {
      resolveEmbeddingProvider({ flagProvider: 'voyage' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('PROVIDER_UNCONFIGURED');
    }
  });

  test('unknown provider throws PROVIDER_UNKNOWN', () => {
    try {
      resolveEmbeddingProvider({ flagProvider: 'bogus' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('PROVIDER_UNKNOWN');
    }
  });

  test('ollama resolves without API key', () => {
    const p = resolveEmbeddingProvider({ flagProvider: 'ollama' });
    expect(p.name).toBe('ollama');
    expect(p.dimensions).toBe(768);
  });

  test('provider name comparison is case-insensitive', () => {
    Bun.env.OPENAI_API_KEY = 'o';
    const p = resolveEmbeddingProvider({ flagProvider: 'OpenAI' });
    expect(p.name).toBe('openai');
  });

  describe('azure-openai', () => {
    test('resolves when key and endpoint are set', () => {
      Bun.env.AZURE_OPENAI_API_KEY = 'az-key';
      Bun.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      const p = resolveEmbeddingProvider({ flagProvider: 'azure-openai' });
      expect(p.name).toBe('azure-openai');
      expect(p.dimensions).toBe(1536);
    });

    test('missing key throws PROVIDER_UNCONFIGURED', () => {
      Bun.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      try {
        resolveEmbeddingProvider({ flagProvider: 'azure-openai' });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe('PROVIDER_UNCONFIGURED');
      }
    });

    test('missing endpoint throws PROVIDER_UNCONFIGURED', () => {
      Bun.env.AZURE_OPENAI_API_KEY = 'az-key';
      try {
        resolveEmbeddingProvider({ flagProvider: 'azure-openai' });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe('PROVIDER_UNCONFIGURED');
      }
    });

    test('endpoint from azureConfig when env not set', () => {
      Bun.env.AZURE_OPENAI_API_KEY = 'az-key';
      const p = resolveEmbeddingProvider({
        flagProvider: 'azure-openai',
        azureConfig: { endpoint: 'https://cfg.openai.azure.com' },
      });
      expect(p.name).toBe('azure-openai');
    });
  });

  describe('inference', () => {
    test('selects openai when OPENAI_API_KEY is set', () => {
      Bun.env.OPENAI_API_KEY = 'o';
      const p = resolveEmbeddingProvider({});
      expect(p.name).toBe('openai');
    });

    test('selects azure-openai when only Azure keys are set', () => {
      Bun.env.AZURE_OPENAI_API_KEY = 'az-key';
      Bun.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      const p = resolveEmbeddingProvider({});
      expect(p.name).toBe('azure-openai');
    });

    test('selects voyage when only VOYAGE_API_KEY is set', () => {
      Bun.env.VOYAGE_API_KEY = 'v';
      const p = resolveEmbeddingProvider({});
      expect(p.name).toBe('voyage');
    });

    test('selects ollama when ollamaConfig provided and no keys', () => {
      const p = resolveEmbeddingProvider({
        ollamaConfig: { host: 'http://localhost:11434' },
      });
      expect(p.name).toBe('ollama');
    });

    test('throws when no keys and no ollamaConfig', () => {
      try {
        resolveEmbeddingProvider({});
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe('PROVIDER_UNCONFIGURED');
      }
    });

    test('openai wins over voyage when both keys set', () => {
      Bun.env.OPENAI_API_KEY = 'o';
      Bun.env.VOYAGE_API_KEY = 'v';
      const p = resolveEmbeddingProvider({});
      expect(p.name).toBe('openai');
    });

    test('explicit provider skips inference', () => {
      Bun.env.OPENAI_API_KEY = 'o';
      Bun.env.VOYAGE_API_KEY = 'v';
      const p = resolveEmbeddingProvider({ flagProvider: 'voyage' });
      expect(p.name).toBe('voyage');
    });
  });

  describe('dimensions override', () => {
    test('GDRIVESCOPE_OPENAI_EMBEDDING_DIMENSIONS overrides default', () => {
      Bun.env.OPENAI_API_KEY = 'o';
      Bun.env.GDRIVESCOPE_OPENAI_EMBEDDING_DIMENSIONS = '3072';
      const p = resolveEmbeddingProvider({});
      expect(p.dimensions).toBe(3072);
    });

    test('GDRIVESCOPE_VOYAGE_EMBEDDING_DIMENSIONS overrides default', () => {
      Bun.env.VOYAGE_API_KEY = 'v';
      Bun.env.GDRIVESCOPE_VOYAGE_EMBEDDING_DIMENSIONS = '1024';
      const p = resolveEmbeddingProvider({ flagProvider: 'voyage' });
      expect(p.dimensions).toBe(1024);
    });

    test('GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_DIMENSIONS overrides default', () => {
      Bun.env.AZURE_OPENAI_API_KEY = 'az';
      Bun.env.AZURE_OPENAI_ENDPOINT = 'https://test.openai.azure.com';
      Bun.env.GDRIVESCOPE_AZURE_OPENAI_EMBEDDING_DIMENSIONS = '3072';
      const p = resolveEmbeddingProvider({ flagProvider: 'azure-openai' });
      expect(p.dimensions).toBe(3072);
    });

    test('invalid env dimension value throws BAD_ARG', () => {
      Bun.env.OPENAI_API_KEY = 'o';
      Bun.env.GDRIVESCOPE_OPENAI_EMBEDDING_DIMENSIONS = 'not-a-number';
      try {
        resolveEmbeddingProvider({});
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CliError);
        expect((err as CliError).code).toBe('BAD_ARG');
      }
    });

    test('embeddingConfig.dimensions is used when env not set', () => {
      Bun.env.OPENAI_API_KEY = 'o';
      const p = resolveEmbeddingProvider({
        embeddingConfig: { dimensions: 768 },
      });
      expect(p.dimensions).toBe(768);
    });

    test('env value wins over embeddingConfig.dimensions', () => {
      Bun.env.OPENAI_API_KEY = 'o';
      Bun.env.GDRIVESCOPE_OPENAI_EMBEDDING_DIMENSIONS = '3072';
      const p = resolveEmbeddingProvider({
        embeddingConfig: { dimensions: 768 },
      });
      expect(p.dimensions).toBe(3072);
    });
  });
});

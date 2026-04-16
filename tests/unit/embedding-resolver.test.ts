import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveEmbeddingProvider } from '../../src/llm/embedding-resolver.js';
import { CliError } from '../../src/utils/errors.js';
import { useEnvGuard } from '../helpers/envGuard.js';

const guard = useEnvGuard([
  'GDRIVESCOPE_EMBEDDING_PROVIDER',
  'OPENAI_API_KEY',
  'VOYAGE_API_KEY',
  'GDRIVESCOPE_OLLAMA_HOST',
  'GDRIVESCOPE_OLLAMA_EMBEDDING_MODEL',
  'GDRIVESCOPE_OLLAMA_EMBEDDING_DIMENSIONS',
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
});

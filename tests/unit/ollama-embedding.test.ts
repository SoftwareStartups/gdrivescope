import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { OllamaEmbeddingProvider } from '../../src/llm/ollama-embedding.js';
import { CliError } from '../../src/utils/errors.js';

let fetchCalls: Array<{ url: string; body: unknown }> = [];
let originalFetch: typeof globalThis.fetch;

function makeVectors(count: number, dims: number): number[][] {
  return Array.from({ length: count }, (_, i) =>
    Array.from({ length: dims }, (_, j) => i * dims + j)
  );
}

function mockFetch(
  ...responses: Array<{ ok: boolean; status: number; body: unknown }>
) {
  let callIndex = 0;
  globalThis.fetch = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const parsed = init?.body ? JSON.parse(init.body as string) : undefined;
      fetchCalls.push({ url, body: parsed });
      const r = responses[callIndex++] ?? responses[responses.length - 1];
      return {
        ok: r.ok,
        status: r.status,
        text: async () =>
          typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
        json: async () => r.body,
      } as Response;
    }
  ) as typeof globalThis.fetch;
}

describe('OllamaEmbeddingProvider', () => {
  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('happy path returns vectors', async () => {
    const vecs = makeVectors(3, 768);
    mockFetch({ ok: true, status: 200, body: { embeddings: vecs } });

    const provider = new OllamaEmbeddingProvider({
      host: 'http://localhost:11434',
      model: 'nomic-embed-text',
      dimensions: 768,
    });
    const result = await provider.embed(['a', 'b', 'c']);

    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(768);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://localhost:11434/api/embed');
  });

  test('batches at 64 texts per call', async () => {
    const batch1 = makeVectors(64, 768);
    const batch2 = makeVectors(36, 768);
    mockFetch(
      { ok: true, status: 200, body: { embeddings: batch1 } },
      { ok: true, status: 200, body: { embeddings: batch2 } }
    );

    const provider = new OllamaEmbeddingProvider({
      host: 'http://localhost:11434',
      model: 'nomic-embed-text',
      dimensions: 768,
    });
    const texts = Array.from({ length: 100 }, (_, i) => `text-${i}`);
    const result = await provider.embed(texts);

    expect(result).toHaveLength(100);
    expect(fetchCalls).toHaveLength(2);
    const body1 = fetchCalls[0].body as Record<string, unknown>;
    const body2 = fetchCalls[1].body as Record<string, unknown>;
    expect((body1.input as string[]).length).toBe(64);
    expect((body2.input as string[]).length).toBe(36);
  });

  test('non-200 throws EMBED_CALL_FAILED', async () => {
    mockFetch({ ok: false, status: 500, body: 'error' });

    const provider = new OllamaEmbeddingProvider({
      host: 'http://localhost:11434',
      model: 'nomic-embed-text',
      dimensions: 768,
    });

    try {
      await provider.embed(['test']);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('EMBED_CALL_FAILED');
    }
  });

  test('connection refused throws PROVIDER_UNAVAILABLE', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;

    const provider = new OllamaEmbeddingProvider({
      host: 'http://localhost:9999',
      model: 'nomic-embed-text',
      dimensions: 768,
    });

    try {
      await provider.embed(['test']);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('PROVIDER_UNAVAILABLE');
    }
  });
});

describe('OllamaEmbeddingProvider.probeDimension', () => {
  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('succeeds when dimensions match', async () => {
    const vecs = makeVectors(1, 768);
    mockFetch({ ok: true, status: 200, body: { embeddings: vecs } });

    await OllamaEmbeddingProvider.probeDimension(
      'http://localhost:11434',
      'nomic-embed-text',
      768
    );
    expect(fetchCalls).toHaveLength(1);
  });

  test('throws EMBEDDING_DIM_MISMATCH on dimension mismatch', async () => {
    const vecs = makeVectors(1, 1024);
    mockFetch({ ok: true, status: 200, body: { embeddings: vecs } });

    try {
      await OllamaEmbeddingProvider.probeDimension(
        'http://localhost:11434',
        'mxbai-embed-large',
        768
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('EMBEDDING_DIM_MISMATCH');
      expect((err as CliError).message).toContain('1024');
      expect((err as CliError).message).toContain('768');
    }
  });

  test('throws PROVIDER_UNAVAILABLE when unreachable', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;

    try {
      await OllamaEmbeddingProvider.probeDimension(
        'http://localhost:9999',
        'nomic-embed-text',
        768
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('PROVIDER_UNAVAILABLE');
    }
  });

  test('throws EMBED_CALL_FAILED on empty response', async () => {
    mockFetch({ ok: true, status: 200, body: { embeddings: [] } });

    try {
      await OllamaEmbeddingProvider.probeDimension(
        'http://localhost:11434',
        'nomic-embed-text',
        768
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('EMBED_CALL_FAILED');
    }
  });
});

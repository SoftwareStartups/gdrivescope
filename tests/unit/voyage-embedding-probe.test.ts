import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { VoyageEmbeddingProvider } from '../../src/llm/voyage-embedding.js';
import { CliError } from '../../src/utils/errors.js';

let originalFetch: typeof globalThis.fetch;
let fetchCalls: Array<{ url: string; body: unknown }> = [];

function mockFetch(response: {
  ok: boolean;
  status: number;
  body: unknown;
}): void {
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
      return {
        ok: response.ok,
        status: response.status,
        text: async () =>
          typeof response.body === 'string'
            ? response.body
            : JSON.stringify(response.body),
        json: async () => response.body,
      } as Response;
    }
  ) as typeof globalThis.fetch;
}

describe('VoyageEmbeddingProvider.probe', () => {
  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('succeeds when dimensions match the declared value', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { data: [{ embedding: Array(1024).fill(0) }] },
    });

    const provider = new VoyageEmbeddingProvider({
      apiKey: 'k',
      model: 'voyage-3',
      dimensions: 1024,
    });
    await provider.probe();
    expect(fetchCalls).toHaveLength(1);
  });

  test('throws EMBEDDING_DIM_MISMATCH when model returns a different width', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { data: [{ embedding: Array(1024).fill(0) }] },
    });

    const provider = new VoyageEmbeddingProvider({
      apiKey: 'k',
      model: 'voyage-3',
      dimensions: 512,
    });
    try {
      await provider.probe();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('EMBEDDING_DIM_MISMATCH');
      expect((err as CliError).message).toContain('1024');
      expect((err as CliError).message).toContain('512');
    }
  });

  test('sends output_dimension when dimensions are explicit', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { data: [{ embedding: Array(256).fill(0) }] },
    });

    const provider = new VoyageEmbeddingProvider({
      apiKey: 'k',
      model: 'voyage-3-large',
      dimensions: 256,
    });
    await provider.probe();
    const body = fetchCalls[0]?.body as { output_dimension?: number };
    expect(body.output_dimension).toBe(256);
  });
});

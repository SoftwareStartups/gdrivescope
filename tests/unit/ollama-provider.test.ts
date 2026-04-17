import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { OllamaProvider } from '../../src/llm/ollama.js';
import { CliError } from '../../src/utils/errors.js';

const VALID_RESPONSE = JSON.stringify({
  summary: 'A test document.',
  classification: 'other',
  key_topics: ['testing'],
});

const INPUT = {
  markdown: '# Hello\nWorld',
  filename: 'test.md',
  path: '/test.md',
  mimeType: 'text/markdown',
};

let fetchCalls: Array<{ url: string; body: unknown }> = [];
let originalFetch: typeof globalThis.fetch;

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

describe('OllamaProvider', () => {
  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('happy path returns parsed LlmSummary', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { message: { content: VALID_RESPONSE } },
    });

    const provider = new OllamaProvider({
      host: 'http://localhost:11434',
      model: 'llama3.2:3b',
    });
    const result = await provider.summarize(INPUT);

    expect(result.summary).toBe('A test document.');
    expect(result.classification).toBe('other');
    expect(result.keyTopics).toEqual(['testing']);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('http://localhost:11434/api/chat');
  });

  test('malformed first attempt retries and succeeds', async () => {
    mockFetch(
      { ok: true, status: 200, body: { message: { content: 'not json' } } },
      {
        ok: true,
        status: 200,
        body: { message: { content: VALID_RESPONSE } },
      }
    );

    const provider = new OllamaProvider({
      host: 'http://localhost:11434',
      model: 'test-model',
    });
    const result = await provider.summarize(INPUT);

    expect(result.summary).toBe('A test document.');
    expect(fetchCalls).toHaveLength(2);
  });

  test('both attempts malformed throws LLM_MALFORMED_OUTPUT', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { message: { content: 'not json at all' } },
    });

    const provider = new OllamaProvider({
      host: 'http://localhost:11434',
      model: 'test-model',
    });

    try {
      await provider.summarize(INPUT);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('LLM_MALFORMED_OUTPUT');
    }
  });

  test('connection refused throws PROVIDER_UNAVAILABLE', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;

    const provider = new OllamaProvider({
      host: 'http://localhost:9999',
      model: 'test-model',
    });

    try {
      await provider.summarize(INPUT);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('PROVIDER_UNAVAILABLE');
      expect((err as CliError).message).toContain('localhost:9999');
    }
  });

  test('non-200 throws LLM_CALL_FAILED', async () => {
    mockFetch({ ok: false, status: 500, body: 'internal error' });

    const provider = new OllamaProvider({
      host: 'http://localhost:11434',
      model: 'test-model',
    });

    try {
      await provider.summarize(INPUT);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('LLM_CALL_FAILED');
    }
  });

  test('sends format schema in request body', async () => {
    mockFetch({
      ok: true,
      status: 200,
      body: { message: { content: VALID_RESPONSE } },
    });

    const provider = new OllamaProvider({
      host: 'http://localhost:11434',
      model: 'test-model',
    });
    await provider.summarize(INPUT);

    const body = fetchCalls[0].body as Record<string, unknown>;
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(false);
    expect(body.format).toBeDefined();
    expect((body.format as Record<string, unknown>).type).toBe('object');
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  run,
  type OllamaSetupFlags,
} from '../../src/cli/commands/ollama-setup.js';
import { useEnvGuard } from '../helpers/envGuard.js';

const guard = useEnvGuard(['GDRIVESCOPE_CONFIG']);

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
let originalFetch: typeof globalThis.fetch;
let spawnCalls: string[][] = [];
let originalSpawnSync: typeof Bun.spawnSync;
let tmpDir: string;

function mockFetchRoutes(
  routes: Record<string, { ok: boolean; status: number; body: unknown }>
) {
  globalThis.fetch = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = init?.method ?? 'GET';
      const parsed = init?.body ? JSON.parse(init.body as string) : undefined;
      fetchCalls.push({ url, method, body: parsed });

      for (const [pattern, response] of Object.entries(routes)) {
        if (url.includes(pattern)) {
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
      }
      return {
        ok: false,
        status: 404,
        text: async () => 'not found',
        json: async () => ({}),
      } as Response;
    }
  ) as typeof globalThis.fetch;
}

describe('ollama setup command', () => {
  beforeEach(async () => {
    guard.setup();
    fetchCalls = [];
    spawnCalls = [];
    originalFetch = globalThis.fetch;
    originalSpawnSync = Bun.spawnSync;

    tmpDir = await import('node:fs/promises').then(async (fs) => {
      const dir = `/tmp/gdrivescope-test-${Date.now()}`;
      await fs.mkdir(dir, { recursive: true });
      return dir;
    });
    Bun.env.GDRIVESCOPE_CONFIG = `${tmpDir}/config.toml`;

    // @ts-expect-error — mock spawnSync for ollama pull
    Bun.spawnSync = mock((opts: { cmd: string[] }) => {
      spawnCalls.push(opts.cmd);
      return { exitCode: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
    });
  });

  afterEach(async () => {
    guard.teardown();
    globalThis.fetch = originalFetch;
    Bun.spawnSync = originalSpawnSync;
    await import('node:fs/promises').then((fs) =>
      fs.rm(tmpDir, { recursive: true, force: true })
    );
  });

  test('pulls missing models and writes config', async () => {
    mockFetchRoutes({
      '/api/tags': {
        ok: true,
        status: 200,
        body: { models: [] },
      },
      '/api/embed': {
        ok: true,
        status: 200,
        body: { embeddings: [Array.from({ length: 768 }, () => 0.1)] },
      },
      '/api/chat': {
        ok: true,
        status: 200,
        body: { message: { content: 'ok' } },
      },
    });

    const result = await run({});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.embeddingDimensions).toBe(768);
    expect(result.data.llmModel).toBe('llama3.2:3b');
    expect(result.data.embeddingModel).toBe('nomic-embed-text');
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[0]).toContain('llama3.2:3b');
    expect(spawnCalls[1]).toContain('nomic-embed-text');

    const configText = await Bun.file(`${tmpDir}/config.toml`).text();
    expect(configText).toContain('ollama');
    expect(configText).toContain('llama3.2:3b');
  });

  test('skips pull when models are installed', async () => {
    mockFetchRoutes({
      '/api/tags': {
        ok: true,
        status: 200,
        body: {
          models: [
            { name: 'llama3.2:3b' },
            { name: 'nomic-embed-text:latest' },
          ],
        },
      },
      '/api/embed': {
        ok: true,
        status: 200,
        body: { embeddings: [Array.from({ length: 768 }, () => 0.1)] },
      },
      '/api/chat': {
        ok: true,
        status: 200,
        body: { message: { content: 'ok' } },
      },
    });

    const result = await run({});

    expect(result.ok).toBe(true);
    expect(spawnCalls).toHaveLength(0);
  });

  test('skip-pull flag skips all pulls', async () => {
    mockFetchRoutes({
      '/api/tags': {
        ok: true,
        status: 200,
        body: { models: [] },
      },
      '/api/embed': {
        ok: true,
        status: 200,
        body: { embeddings: [Array.from({ length: 768 }, () => 0.1)] },
      },
      '/api/chat': {
        ok: true,
        status: 200,
        body: { message: { content: 'ok' } },
      },
    });

    const flags: OllamaSetupFlags = { 'skip-pull': true };
    const result = await run(flags);

    expect(result.ok).toBe(true);
    expect(spawnCalls).toHaveLength(0);
  });

  test('unreachable ollama returns PROVIDER_UNAVAILABLE', async () => {
    globalThis.fetch = mock(async () => {
      throw new TypeError('fetch failed');
    }) as typeof globalThis.fetch;

    const result = await run({});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.code).toBe('PROVIDER_UNAVAILABLE');
  });

  test('embed validation failure returns EMBED_CALL_FAILED', async () => {
    mockFetchRoutes({
      '/api/tags': {
        ok: true,
        status: 200,
        body: {
          models: [{ name: 'llama3.2:3b' }, { name: 'nomic-embed-text' }],
        },
      },
      '/api/embed': {
        ok: false,
        status: 500,
        body: 'model error',
      },
    });

    const result = await run({});

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.code).toBe('EMBED_CALL_FAILED');
  });

  test('custom models are passed through', async () => {
    mockFetchRoutes({
      '/api/tags': {
        ok: true,
        status: 200,
        body: { models: [] },
      },
      '/api/embed': {
        ok: true,
        status: 200,
        body: { embeddings: [Array.from({ length: 1024 }, () => 0.1)] },
      },
      '/api/chat': {
        ok: true,
        status: 200,
        body: { message: { content: 'ok' } },
      },
    });

    const flags: OllamaSetupFlags = {
      'llm-model': 'qwen2.5:3b-instruct',
      'embedding-model': 'mxbai-embed-large',
    };
    const result = await run(flags);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.data.llmModel).toBe('qwen2.5:3b-instruct');
    expect(result.data.embeddingModel).toBe('mxbai-embed-large');
    expect(result.data.embeddingDimensions).toBe(1024);
    expect(spawnCalls[0]).toContain('qwen2.5:3b-instruct');
    expect(spawnCalls[1]).toContain('mxbai-embed-large');
  });
});

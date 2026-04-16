import { describe, expect, test } from 'bun:test';
import { runBounded, withBackoff } from '../../src/pipeline/concurrency.js';

describe('withBackoff', () => {
  test('retries 429 until success', async () => {
    let calls = 0;
    const result = await withBackoff(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw { status: 429 };
        }
        return 'ok';
      },
      { baseMs: 1, capMs: 4, jitter: 0 }
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  test('does not retry non-retryable status', async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls += 1;
          throw { status: 500 };
        },
        { baseMs: 1, capMs: 4, jitter: 0 }
      )
    ).rejects.toEqual({ status: 500 });
    expect(calls).toBe(1);
  });

  test('honors retries: 0', async () => {
    let calls = 0;
    await expect(
      withBackoff(
        async () => {
          calls += 1;
          throw { status: 429 };
        },
        { retries: 0, baseMs: 1, jitter: 0 }
      )
    ).rejects.toEqual({ status: 429 });
    expect(calls).toBe(1);
  });

  test('retries Anthropic overloaded_error', async () => {
    let calls = 0;
    const result = await withBackoff(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw { error: { type: 'overloaded_error' } };
        }
        return 42;
      },
      { baseMs: 1, capMs: 4, jitter: 0 }
    );
    expect(result).toBe(42);
    expect(calls).toBe(2);
  });

  test('custom isRetryable overrides defaults', async () => {
    let calls = 0;
    const result = await withBackoff(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return 'ok';
      },
      {
        baseMs: 1,
        capMs: 4,
        jitter: 0,
        isRetryable: (err) => err instanceof Error && err.message === 'boom',
      }
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('runBounded', () => {
  test('caps concurrency and preserves order', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    const results = await runBounded({
      items,
      max: 3,
      fn: async (x) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return x * 2;
      },
    });
    expect(results).toEqual(items.map((x) => x * 2));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test('onError absorbs failure and run continues', async () => {
    const errors: Array<{ item: number; err: unknown }> = [];
    const results = await runBounded({
      items: [1, 2, 3, 4],
      max: 2,
      fn: async (x) => {
        if (x === 2) throw new Error(`boom ${x}`);
        return x * 10;
      },
      onError: (item, err) => {
        errors.push({ item, err });
      },
    });
    expect(results).toEqual([10, undefined, 30, 40]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.item).toBe(2);
  });

  test('rethrows without onError', async () => {
    await expect(
      runBounded({
        items: [1, 2],
        max: 2,
        fn: async () => {
          throw new Error('nope');
        },
      })
    ).rejects.toThrow('nope');
  });
});

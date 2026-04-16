export interface Semaphore {
  acquire(): Promise<() => void>;
  readonly inFlight: number;
}

export function createSemaphore(max: number): Semaphore {
  if (max < 1) {
    throw new Error(`Semaphore max must be >= 1 (got ${max})`);
  }
  let inFlight = 0;
  const queue: Array<() => void> = [];

  const release = (): void => {
    inFlight -= 1;
    const next = queue.shift();
    if (next) {
      inFlight += 1;
      next();
    }
  };

  return {
    get inFlight(): number {
      return inFlight;
    },
    acquire(): Promise<() => void> {
      return new Promise<() => void>((resolve) => {
        const grant = (): void => resolve(release);
        if (inFlight < max) {
          inFlight += 1;
          grant();
        } else {
          queue.push(grant);
        }
      });
    },
  };
}

export interface RunBoundedOpts<T, R> {
  items: readonly T[];
  max: number;
  fn: (item: T, index: number) => Promise<R>;
  onError?: (item: T, err: unknown, index: number) => void | Promise<void>;
}

export async function runBounded<T, R>(
  opts: RunBoundedOpts<T, R>
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(opts.items.length);
  const sem = createSemaphore(opts.max);
  await Promise.all(
    opts.items.map(async (item, idx) => {
      const release = await sem.acquire();
      try {
        results[idx] = await opts.fn(item, idx);
      } catch (err) {
        if (opts.onError) {
          await opts.onError(item, err, idx);
        } else {
          throw err;
        }
      } finally {
        release();
      }
    })
  );
  return results;
}

export interface BackoffOptions {
  retries?: number;
  baseMs?: number;
  capMs?: number;
  jitter?: number;
  isRetryable?: (err: unknown) => boolean;
}

interface RetryableShape {
  status?: number;
  code?: string;
  error?: { type?: string };
}

const DEFAULT_RETRYABLE = (err: unknown): boolean => {
  if (err == null || typeof err !== 'object') return false;
  const e = err as RetryableShape;
  if (e.status === 429 || e.status === 503 || e.status === 529) return true;
  const type = e.error?.type;
  if (type === 'overloaded_error' || type === 'rate_limit_error') return true;
  if (e.code === 'ETIMEDOUT' || e.code === 'ENETDOWN') return true;
  return false;
};

export async function withBackoff<T>(
  fn: () => Promise<T>,
  opts: BackoffOptions = {}
): Promise<T> {
  const retries = opts.retries ?? 4;
  const base = opts.baseMs ?? 500;
  const cap = opts.capMs ?? 30_000;
  const jitter = opts.jitter ?? 0.2;
  const retryable = opts.isRetryable ?? DEFAULT_RETRYABLE;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !retryable(err)) throw err;
      const raw = Math.min(cap, base * 2 ** attempt);
      const delta = raw * jitter;
      const sleep = raw - delta + Math.random() * (2 * delta);
      await new Promise((resolve) => setTimeout(resolve, sleep));
    }
  }
  throw new Error('unreachable');
}

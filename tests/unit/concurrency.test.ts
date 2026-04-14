import { describe, expect, test } from 'bun:test';
import { createSemaphore } from '../../src/drive/concurrency.js';

describe('createSemaphore', () => {
  test('caps in-flight at max and queues overflow', async () => {
    const sem = createSemaphore(2);

    const releaseA = await sem.acquire();
    const releaseB = await sem.acquire();
    expect(sem.inFlight).toBe(2);

    let thirdAcquired = false;
    const thirdPromise = sem.acquire().then((release) => {
      thirdAcquired = true;
      return release;
    });

    // Give the event loop a tick — the third acquire must still be queued.
    await Promise.resolve();
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);
    expect(sem.inFlight).toBe(2);

    releaseA();
    const releaseC = await thirdPromise;
    expect(thirdAcquired).toBe(true);
    expect(sem.inFlight).toBe(2);

    releaseB();
    releaseC();
    expect(sem.inFlight).toBe(0);
  });

  test('release inside finally frees a permit even when the caller throws', async () => {
    const sem = createSemaphore(1);

    await expect(
      (async () => {
        const release = await sem.acquire();
        try {
          throw new Error('boom');
        } finally {
          release();
        }
      })()
    ).rejects.toThrow('boom');

    expect(sem.inFlight).toBe(0);
    const release = await sem.acquire();
    expect(sem.inFlight).toBe(1);
    release();
  });

  test('rejects invalid max', () => {
    expect(() => createSemaphore(0)).toThrow();
  });
});

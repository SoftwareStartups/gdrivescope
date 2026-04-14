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

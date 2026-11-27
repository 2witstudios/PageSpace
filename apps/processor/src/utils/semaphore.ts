/**
 * A counting semaphore: at most `limit` tasks run at once, the rest wait in
 * arrival order. In-process only — it bounds work inside one processor.
 */
export interface Semaphore {
  run<T>(work: () => Promise<T>): Promise<T>;
}

export function createSemaphore(limit: number): Semaphore {
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = async (): Promise<void> => {
    if (active < limit) {
      active++;
      return;
    }
    // The releasing task hands its slot straight to the next waiter.
    await new Promise<void>((resolve) => waiting.push(resolve));
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next) next();
    else active--;
  };

  return {
    async run(work) {
      await acquire();
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

/** A positive integer from an env value, else the fallback. */
export function positiveIntOr(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

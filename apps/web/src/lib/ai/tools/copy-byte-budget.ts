/**
 * A process-wide budget on the bytes of large copies held in this server at once.
 *
 * `MAX_BINARY_COPY_BYTES` bounds ONE copy. A model can issue many tool calls in
 * parallel, and every binary copy holds its whole file in memory on the way
 * through (a FILE page's original fetched for the sandbox, a sandbox file read
 * for the drive) — ten 200 MB copies at once is 2 GB in one Next.js process.
 * This budget bounds the SUM: a copy reserves its size before the bytes arrive
 * and releases it once they have been written onward.
 *
 * Waiters are served in arrival order, so a large copy is not starved by small
 * ones behind it, and a waiter that cannot be served within `waitMs` is refused
 * (the agent is told to retry) rather than held for the rest of its turn.
 */

/** Default ceiling on in-flight copy bytes per process: two full-size copies at a time. */
export const DEFAULT_COPY_INFLIGHT_BYTES = 512 * 1024 * 1024;

/** How long a copy waits for room before it is refused. */
export const COPY_BUDGET_WAIT_MS = 15_000;

/** Pure: the budget for `env` (`COPY_CONTENT_MAX_INFLIGHT_BYTES`). Junk or zero keeps the default. */
export function resolveCopyInflightBytes(env: Record<string, string | undefined>): number {
  const raw = env.COPY_CONTENT_MAX_INFLIGHT_BYTES?.trim();
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_COPY_INFLIGHT_BYTES;
  const value = Number.parseInt(raw, 10);
  return value > 0 ? value : DEFAULT_COPY_INFLIGHT_BYTES;
}

export interface ByteBudget {
  /** Reserve `bytes`; resolves to a release function, or null when refused. */
  acquire(bytes: number): Promise<(() => void) | null>;
  inFlightBytes(): number;
}

interface Waiter {
  bytes: number;
  grant: (release: () => void) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function createByteBudget({ capacityBytes, waitMs }: { capacityBytes: number; waitMs: number }): ByteBudget {
  let inFlight = 0;
  const queue: Waiter[] = [];

  const releaserFor = (bytes: number): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight -= bytes;
      drain();
    };
  };

  function drain(): void {
    while (queue.length > 0 && inFlight + queue[0].bytes <= capacityBytes) {
      const next = queue.shift() as Waiter;
      clearTimeout(next.timer);
      inFlight += next.bytes;
      next.grant(releaserFor(next.bytes));
    }
  }

  return {
    acquire(bytes) {
      if (bytes > capacityBytes) return Promise.resolve(null);
      if (queue.length === 0 && inFlight + bytes <= capacityBytes) {
        inFlight += bytes;
        return Promise.resolve(releaserFor(bytes));
      }
      return new Promise((resolve) => {
        const waiter: Waiter = {
          bytes,
          grant: resolve,
          timer: setTimeout(() => {
            const at = queue.indexOf(waiter);
            if (at !== -1) queue.splice(at, 1);
            resolve(null);
            // Its place freed may let the next waiter in.
            drain();
          }, waitMs),
        };
        queue.push(waiter);
      });
    },
    inFlightBytes: () => inFlight,
  };
}

/** The one budget this server process holds for `copy_content`. */
export const copyByteBudget: ByteBudget = createByteBudget({
  capacityBytes: resolveCopyInflightBytes(process.env),
  waitMs: COPY_BUDGET_WAIT_MS,
});

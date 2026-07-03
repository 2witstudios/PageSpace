/**
 * Pure backoff schedule + idempotency classification (Phase 2 task 6).
 *
 * No I/O, no clock, no `Math.random` — the jitter source is injected so the
 * schedule is fully deterministic under test (a fixed jitter function makes
 * `computeBackoff` referentially transparent) and so the facade (client.ts)
 * is the only place that ever wires in real randomness.
 */
import type { HttpMethod } from './transport/types.js';

export interface RetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
};

/** Returns a fraction in `[0, 1]` scaling the computed delay; injected so tests can fix it. */
export type Jitter = () => number;

/**
 * Full-jitter exponential backoff: attempt 1 waits `baseDelayMs`, doubling
 * per subsequent attempt up to `maxDelayMs`, then scaled by `jitter()`.
 * Pure and total for `attempt >= 1`; calls `jitter()` exactly once.
 */
export function computeBackoff(attempt: number, policy: RetryPolicy, jitter: Jitter): number {
  if (attempt < 1) {
    throw new RangeError(`attempt must be >= 1, got ${attempt}`);
  }
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  return Math.round(capped * jitter());
}

/**
 * Derives retry-safety from the operation's HTTP method (registry-derived,
 * per the epic's zero-trust non-negotiable: a create that timed out may have
 * already succeeded, so only GET is ever auto-retried).
 */
export function isIdempotentMethod(method: HttpMethod | string): boolean {
  return method === 'GET';
}

/**
 * Distributed Rate Limit Integration Tests
 *
 * Tests against a real Postgres database. Skips gracefully when DB is unavailable.
 * Exercises the Postgres-backed (key, window_start) bucket implementation.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { db, rateLimitBuckets, sql, eq } from '@pagespace/db';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  shutdownRateLimiting,
  type RateLimitConfig,
} from '../distributed-rate-limit';

let dbAvailable = false;
const TEST_KEY_PREFIX = 'itest:rl:';

beforeAll(async () => {
  try {
    await db.execute(sql`SELECT 1`);
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

beforeEach(async () => {
  if (dbAvailable) {
    await db
      .delete(rateLimitBuckets)
      .where(sql`${rateLimitBuckets.key} LIKE ${TEST_KEY_PREFIX + '%'}`);
  }
  shutdownRateLimiting();
});

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  vi.restoreAllMocks();
});

describe('distributed-rate-limit integration (Postgres)', () => {
  it('allows requests under the limit', async () => {
    if (!dbAvailable) return;

    const cfg: RateLimitConfig = { maxAttempts: 3, windowMs: 60_000 };
    const key = TEST_KEY_PREFIX + 'under-limit';

    const r1 = await checkDistributedRateLimit(key, cfg);
    const r2 = await checkDistributedRateLimit(key, cfg);

    expect(r1.allowed).toBe(true);
    expect(r1.attemptsRemaining).toBe(2);
    expect(r2.allowed).toBe(true);
    expect(r2.attemptsRemaining).toBe(1);
  });

  it('blocks at the limit and returns Retry-After', async () => {
    if (!dbAvailable) return;

    const cfg: RateLimitConfig = { maxAttempts: 2, windowMs: 60_000 };
    const key = TEST_KEY_PREFIX + 'at-limit';

    await checkDistributedRateLimit(key, cfg);
    await checkDistributedRateLimit(key, cfg);
    const blocked = await checkDistributedRateLimit(key, cfg);

    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(60);
    expect(blocked.attemptsRemaining).toBe(0);
  });

  it('weighted sliding window: same bucket stays blocked; prev bucket fully decays after two full windows', async () => {
    if (!dbAvailable) return;

    const windowMs = 2_000;
    const cfg: RateLimitConfig = { maxAttempts: 1, windowMs };
    const key = TEST_KEY_PREFIX + 'window';

    // Align to a fresh bucket with safety margin so t + window - 1s stays in-bucket.
    const now = Date.now();
    const boundary = Math.ceil(now / windowMs) * windowMs;
    await new Promise((r) => setTimeout(r, boundary - now + 50));

    const r1 = await checkDistributedRateLimit(key, cfg); // t (bucket A, count 1)
    expect(r1.allowed).toBe(true);

    const r2 = await checkDistributedRateLimit(key, cfg); // t + ~0s — same bucket
    expect(r2.allowed).toBe(false);

    // Wait two full windows: bucket A rolls out of the weighted sum entirely.
    // (Waiting just one window would land us in bucket B with A still weighted.)
    await new Promise((r) => setTimeout(r, 2 * windowMs));

    const r3 = await checkDistributedRateLimit(key, cfg);
    expect(r3.allowed).toBe(true);
  }, 15_000); // bucket alignment + 2 windows + DB round-trips exceed default 5s timeout

  it('boundary bursting is blocked by weighted sliding window', async () => {
    if (!dbAvailable) return;

    // With a pure fixed-window limiter, an attacker can do maxAttempts right
    // before a bucket boundary and maxAttempts right after — a 2x burst.
    // The weighted window must keep them blocked as long as the previous
    // bucket is still heavily weighted.
    const windowMs = 2_000;
    const cfg: RateLimitConfig = { maxAttempts: 2, windowMs };
    const key = TEST_KEY_PREFIX + 'burst';

    const now = Date.now();
    const boundary = Math.ceil(now / windowMs) * windowMs;
    await new Promise((r) => setTimeout(r, boundary - now + 50));

    // Fill bucket A to the limit.
    await checkDistributedRateLimit(key, cfg);
    await checkDistributedRateLimit(key, cfg);

    // Cross the boundary into bucket B with almost no delay. The previous
    // bucket's weight is ≈ 1, so effective = 1 + 2 * ~1 = ~3 > 2 → blocked.
    await new Promise((r) => setTimeout(r, windowMs));
    const atBoundary = await checkDistributedRateLimit(key, cfg);
    expect(atBoundary.allowed).toBe(false);
  }, 10_000); // bucket alignment + 1 window + DB round-trips can exceed default 5s

  it('fails closed in production when DB is unavailable', async () => {
    if (!dbAvailable) return;

    process.env.NODE_ENV = 'production';
    const cfg: RateLimitConfig = { maxAttempts: 5, windowMs: 60_000 };
    const key = TEST_KEY_PREFIX + 'fail-closed';

    vi.spyOn(db, 'insert').mockImplementation(() => {
      throw new Error('DB unavailable');
    });

    const result = await checkDistributedRateLimit(key, cfg);

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBe(60);
    expect(result.attemptsRemaining).toBe(0);
  });

  it('concurrent increments against the same bucket are atomic (final count === N)', async () => {
    if (!dbAvailable) return;

    const windowMs = 60_000;
    const cfg: RateLimitConfig = { maxAttempts: 10_000, windowMs };
    const key = TEST_KEY_PREFIX + 'concurrent';
    const N = 50;

    // Align away from a bucket edge to keep all N in the same (key, window_start) row.
    const now = Date.now();
    const msIntoBucket = now % windowMs;
    if (msIntoBucket > windowMs - 1_000) {
      await new Promise((r) => setTimeout(r, windowMs - msIntoBucket + 50));
    }

    await Promise.all(
      Array.from({ length: N }, () => checkDistributedRateLimit(key, cfg)),
    );

    const rows = await db
      .select({ count: rateLimitBuckets.count })
      .from(rateLimitBuckets)
      .where(eq(rateLimitBuckets.key, key));

    const total = rows.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(N);
  });

  it('resetDistributedRateLimit clears counters for the identifier', async () => {
    if (!dbAvailable) return;

    const cfg: RateLimitConfig = { maxAttempts: 1, windowMs: 60_000 };
    const key = TEST_KEY_PREFIX + 'reset';

    await checkDistributedRateLimit(key, cfg);
    const blocked = await checkDistributedRateLimit(key, cfg);
    expect(blocked.allowed).toBe(false);

    await resetDistributedRateLimit(key);

    const afterReset = await checkDistributedRateLimit(key, cfg);
    expect(afterReset.allowed).toBe(true);
  });
});

/**
 * AI-usage rate-limit cache integration tests (Postgres)
 *
 * Exercises the Postgres-backed `RateLimitCache` against a real database
 * using the shared `rate_limit_buckets (key, window_start)` table.
 *
 * Skips gracefully when the DB is unavailable (see scripts/test-with-db.sh).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, rateLimitBuckets, sql, eq } from '@pagespace/db';
import { RateLimitCache, type ProviderType } from '../rate-limit-cache';

interface AssertParams {
  given: string;
  should: string;
  actual: unknown;
  expected: unknown;
}

const assert = ({ given, should, actual, expected }: AssertParams): void => {
  expect(actual, `Given ${given}, should ${should}`).toEqual(expected);
};

const KEY_PREFIX = 'ai-usage:';
let dbAvailable = false;

async function clearAiUsageBuckets(): Promise<void> {
  await db
    .delete(rateLimitBuckets)
    .where(sql`${rateLimitBuckets.key} LIKE ${KEY_PREFIX + '%'}`);
}

async function freshCache(): Promise<RateLimitCache> {
  const existing = RateLimitCache.getInstance();
  await existing.shutdown();
  return RateLimitCache.getInstance();
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

describe('RateLimitCache (Postgres integration)', () => {
  beforeAll(async () => {
    try {
      await db.execute(sql`SELECT 1`);
      dbAvailable = true;
    } catch {
      dbAvailable = false;
    }
  });

  beforeEach(async () => {
    if (dbAvailable) await clearAiUsageBuckets();
    await freshCache();
  });

  afterEach(async () => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    await RateLimitCache.getInstance().shutdown();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (dbAvailable) await clearAiUsageBuckets();
  });

  describe('incrementUsage under limit', () => {
    it('returns sequential counts 1, 2, 3 for three successive increments', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();

      const r1 = await cache.incrementUsage('user-a', 'standard', 10);
      const r2 = await cache.incrementUsage('user-a', 'standard', 10);
      const r3 = await cache.incrementUsage('user-a', 'standard', 10);

      assert({
        given: 'three sequential increments under the limit',
        should: 'return success with monotonically increasing counts',
        actual: [r1.currentCount, r2.currentCount, r3.currentCount],
        expected: [1, 2, 3],
      });
      assert({
        given: 'three sequential increments under the limit',
        should: 'report remaining calls correctly',
        actual: r3.remainingCalls,
        expected: 7,
      });
    });
  });

  describe('incrementUsage at and beyond limit', () => {
    it('blocks once the cap is reached and preserves currentCount at limit', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();
      const limit = 3;

      for (let i = 0; i < limit; i++) {
        await cache.incrementUsage('user-cap', 'standard', limit);
      }
      const over = await cache.incrementUsage('user-cap', 'standard', limit);

      assert({
        given: 'an additional increment after the cap has been reached',
        should: 'return blocked with currentCount pinned to the limit',
        actual: { success: over.success, currentCount: over.currentCount, remainingCalls: over.remainingCalls },
        expected: { success: false, currentCount: limit, remainingCalls: 0 },
      });
    });
  });

  describe('key scheme and bucket storage', () => {
    it('writes to rate_limit_buckets under the ai-usage:{userId}:{providerType} prefix', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();

      await cache.incrementUsage('user-keys', 'pro', 10);

      const rows = await db
        .select({ key: rateLimitBuckets.key, count: rateLimitBuckets.count })
        .from(rateLimitBuckets)
        .where(eq(rateLimitBuckets.key, 'ai-usage:user-keys:pro'));

      assert({
        given: 'a single increment for user-keys/pro',
        should: 'insert one row keyed ai-usage:user-keys:pro with count 1',
        actual: rows.map(r => ({ key: r.key, count: r.count })),
        expected: [{ key: 'ai-usage:user-keys:pro', count: 1 }],
      });
    });
  });

  describe('provider isolation', () => {
    it('keeps separate buckets for standard and pro under the same user', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();

      await cache.incrementUsage('user-iso', 'standard', 10);
      await cache.incrementUsage('user-iso', 'standard', 10);
      await cache.incrementUsage('user-iso', 'pro', 10);

      const standard = await cache.getCurrentUsage('user-iso', 'standard', 10);
      const pro = await cache.getCurrentUsage('user-iso', 'pro', 10);

      assert({
        given: 'two standard increments and one pro increment for the same user',
        should: 'track standard and pro counters independently',
        actual: { standard: standard.currentCount, pro: pro.currentCount },
        expected: { standard: 2, pro: 1 },
      });
    });
  });

  describe('user isolation', () => {
    it('keeps separate buckets across users for the same provider', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();

      await cache.incrementUsage('user-1', 'standard', 10);
      await cache.incrementUsage('user-1', 'standard', 10);
      await cache.incrementUsage('user-2', 'standard', 10);

      const u1 = await cache.getCurrentUsage('user-1', 'standard', 10);
      const u2 = await cache.getCurrentUsage('user-2', 'standard', 10);

      assert({
        given: 'two users incrementing the same provider bucket',
        should: 'track each user independently',
        actual: { u1: u1.currentCount, u2: u2.currentCount },
        expected: { u1: 2, u2: 1 },
      });
    });
  });

  describe('midnight-UTC window roll', () => {
    it('today starts at count=1 even when yesterday already recorded a count', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);

      await db.insert(rateLimitBuckets).values({
        key: 'ai-usage:user-roll:standard',
        windowStart: yesterday,
        count: 3,
        expiresAt: today,
      });

      const firstOfToday = await cache.incrementUsage('user-roll', 'standard', 100);

      assert({
        given: "a pre-existing bucket for yesterday's window",
        should: 'open a new bucket for today with count=1 (separate window_start row)',
        actual: firstOfToday.currentCount,
        expected: 1,
      });
    });
  });

  describe('getCurrentUsage', () => {
    it('returns zero usage for a brand-new user without touching the bucket', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();

      const usage = await cache.getCurrentUsage('user-new', 'standard', 10);
      const rows = await db
        .select()
        .from(rateLimitBuckets)
        .where(eq(rateLimitBuckets.key, 'ai-usage:user-new:standard'));

      assert({
        given: 'a user with no prior increments',
        should: 'report currentCount=0 and not create a bucket row',
        actual: { currentCount: usage.currentCount, bucketRows: rows.length },
        expected: { currentCount: 0, bucketRows: 0 },
      });
    });
  });

  describe('resetUsage', () => {
    it('clears the bucket for the specified user and provider', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();

      for (let i = 0; i < 5; i++) {
        await cache.incrementUsage('user-reset', 'standard', 10);
      }
      await cache.resetUsage('user-reset', 'standard');
      const usage = await cache.getCurrentUsage('user-reset', 'standard', 10);

      assert({
        given: 'five increments followed by a reset',
        should: 'restore the counter to zero',
        actual: usage.currentCount,
        expected: 0,
      });
    });
  });

  describe('concurrent increment atomicity', () => {
    it('N parallel increments produce a final DB count of exactly N', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();
      const N = 25;
      const limit = 10_000;

      await Promise.all(
        Array.from({ length: N }, () =>
          cache.incrementUsage('user-concurrent', 'standard', limit),
        ),
      );

      const rows = await db
        .select({ count: rateLimitBuckets.count })
        .from(rateLimitBuckets)
        .where(eq(rateLimitBuckets.key, 'ai-usage:user-concurrent:standard'));

      const total = rows.reduce((sum, r) => sum + r.count, 0);
      assert({
        given: `${N} concurrent increments against the same bucket`,
        should: 'serialize via the row lock and produce an exact final count',
        actual: total,
        expected: N,
      });
    });
  });

  describe('fail-closed in production when DB is down', () => {
    it('returns blocked without throwing when the DB driver rejects in production', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();

      process.env.NODE_ENV = 'production';
      vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('DB unavailable');
      });

      const result = await cache.incrementUsage('user-fail', 'standard', 5);

      assert({
        given: 'a DB failure in production',
        should: 'fail closed: block the request and expose remainingCalls=0',
        actual: { success: result.success, remainingCalls: result.remainingCalls },
        expected: { success: false, remainingCalls: 0 },
      });
    });
  });

  describe('expiresAt window', () => {
    it('aligns window_start to today-midnight-UTC and expires_at to tomorrow-midnight-UTC', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();

      const todayMidnight = new Date();
      todayMidnight.setUTCHours(0, 0, 0, 0);
      const tomorrowMidnight = new Date(todayMidnight);
      tomorrowMidnight.setUTCDate(tomorrowMidnight.getUTCDate() + 1);

      await cache.incrementUsage('user-expiry', 'standard', 10);

      const rows = await db
        .select({ windowStart: rateLimitBuckets.windowStart, expiresAt: rateLimitBuckets.expiresAt })
        .from(rateLimitBuckets)
        .where(eq(rateLimitBuckets.key, 'ai-usage:user-expiry:standard'));

      assert({
        given: 'a single increment',
        should: "align window_start to today's UTC midnight and expires_at to tomorrow's",
        actual: {
          windowStart: rows[0]?.windowStart.toISOString(),
          expiresAt: rows[0]?.expiresAt.toISOString(),
        },
        expected: {
          windowStart: todayMidnight.toISOString(),
          expiresAt: tomorrowMidnight.toISOString(),
        },
      });
    });
  });

  describe('strict cap under concurrent bursts', () => {
    it('splits N parallel increments with cap C into exactly C successes and N-C blocks', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();
      const N = 30;
      const cap = 10;

      const results = await Promise.all(
        Array.from({ length: N }, () =>
          cache.incrementUsage('user-burst', 'standard', cap),
        ),
      );

      const successes = results.filter(r => r.success).length;
      const blocks = results.filter(r => !r.success).length;
      const finalUsage = await cache.getCurrentUsage('user-burst', 'standard', cap);

      assert({
        given: `${N} concurrent increments against a cap of ${cap}`,
        should: `return exactly ${cap} successes and ${N - cap} blocks, with final count pinned at the cap`,
        actual: { successes, blocks, finalCount: finalUsage.currentCount },
        expected: { successes: cap, blocks: N - cap, finalCount: cap },
      });
    });
  });

  describe('zero-limit short-circuit', () => {
    it('returns blocked without writing a DB row when the limit is zero', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();

      const result = await cache.incrementUsage('user-zero', 'pro', 0);
      const rows = await db
        .select()
        .from(rateLimitBuckets)
        .where(eq(rateLimitBuckets.key, 'ai-usage:user-zero:pro'));

      assert({
        given: 'an increment with limit=0',
        should: 'return blocked and leave the bucket table untouched',
        actual: { success: result.success, remainingCalls: result.remainingCalls, bucketRows: rows.length },
        expected: { success: false, remainingCalls: 0, bucketRows: 0 },
      });
    });
  });

  describe('clearAll', () => {
    it('removes every ai-usage bucket row', async () => {
      if (!dbAvailable) return;
      const cache = RateLimitCache.getInstance();

      await cache.incrementUsage('user-clear-1', 'standard', 10);
      await cache.incrementUsage('user-clear-2', 'pro', 10);
      await cache.clearAll();

      const rows = await db
        .select()
        .from(rateLimitBuckets)
        .where(sql`${rateLimitBuckets.key} LIKE ${KEY_PREFIX + '%'}`);

      assert({
        given: 'two distinct buckets followed by clearAll',
        should: 'empty the ai-usage namespace entirely',
        actual: rows.length,
        expected: 0,
      });
    });
  });

  describe('cross-instance persistence', () => {
    it('a fresh RateLimitCache instance reads the count written by the previous one', async () => {
      if (!dbAvailable) return;

      const first = RateLimitCache.getInstance();
      await first.incrementUsage('user-persist', 'standard', 10);
      await first.shutdown();

      const second = RateLimitCache.getInstance();
      const usage = await second.getCurrentUsage('user-persist', 'standard', 10);

      assert({
        given: 'a previous instance that incremented once',
        should: 'read the persisted count from the DB on a fresh instance',
        actual: usage.currentCount,
        expected: 1,
      });
    });
  });
});

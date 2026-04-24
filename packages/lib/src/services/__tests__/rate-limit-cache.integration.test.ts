/**
 * AI-usage rate-limit cache integration tests (Postgres)
 *
 * Exercises the Postgres-backed `RateLimitCache` against a real database
 * using the shared `rate_limit_buckets (key, window_start)` table.
 *
 * The entire suite is skipped when `DATABASE_URL` is unset (CI paths that
 * don't provision a DB). When `DATABASE_URL` is set but the DB is
 * unreachable, the first `db.execute` in `beforeAll` throws and the suite
 * fails loudly — we deliberately do not swallow liveness errors so
 * regressions cannot hide behind silent skips.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@pagespace/db/db';
import { sql, eq } from '@pagespace/db/operators';
import { rateLimitBuckets } from '@pagespace/db/schema/rate-limit-buckets';
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

describe.skipIf(!process.env.DATABASE_URL)('RateLimitCache (Postgres integration)', () => {
  beforeAll(async () => {
    await db.execute(sql`SELECT 1`);
  });

  beforeEach(async () => {
    await clearAiUsageBuckets();
    await freshCache();
  });

  afterEach(async () => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    await RateLimitCache.getInstance().shutdown();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await clearAiUsageBuckets();
  });

  describe('incrementUsage under limit', () => {
    it('returns sequential counts 1, 2, 3 for three successive increments', async () => {
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
      const cache = RateLimitCache.getInstance();

      const now = new Date();
      const today = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const yesterday = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
      );

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
      const cache = RateLimitCache.getInstance();

      const now = new Date();
      const todayMidnight = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const tomorrowMidnight = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
      );

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

  describe('dev fallback: incrementUsage when DB is unreachable', () => {
    it('falls back to the in-memory counter and succeeds under the limit', async () => {
      process.env.NODE_ENV = 'development';
      const cache = RateLimitCache.getInstance();
      vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('DB unavailable');
      });

      const r1 = await cache.incrementUsage('user-dev-fallback', 'standard', 3);
      const r2 = await cache.incrementUsage('user-dev-fallback', 'standard', 3);

      assert({
        given: 'two increments in development while the DB is down',
        should: 'serve success from the in-memory fallback with monotonic counts',
        actual: [
          { success: r1.success, currentCount: r1.currentCount },
          { success: r2.success, currentCount: r2.currentCount },
        ],
        expected: [
          { success: true, currentCount: 1 },
          { success: true, currentCount: 2 },
        ],
      });
    });

    it('blocks in-memory fallback writers once the cap is reached', async () => {
      process.env.NODE_ENV = 'development';
      const cache = RateLimitCache.getInstance();
      vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('DB unavailable');
      });

      await cache.incrementUsage('user-dev-cap', 'pro', 1);
      const overflow = await cache.incrementUsage('user-dev-cap', 'pro', 1);

      assert({
        given: 'a dev-fallback increment beyond the cap',
        should: 'return blocked and pin currentCount at the cap',
        actual: { success: overflow.success, currentCount: overflow.currentCount },
        expected: { success: false, currentCount: 1 },
      });
    });
  });

  describe('dev fallback: getCurrentUsage when DB is unreachable', () => {
    it('returns the last in-memory count when the DB read throws', async () => {
      process.env.NODE_ENV = 'development';
      const cache = RateLimitCache.getInstance();

      await cache.incrementUsage('user-dev-read', 'standard', 10);
      await cache.incrementUsage('user-dev-read', 'standard', 10);

      vi.spyOn(db, 'select').mockImplementation(() => {
        throw new Error('DB unavailable');
      });

      const usage = await cache.getCurrentUsage('user-dev-read', 'standard', 10);

      assert({
        given: 'two prior successful increments and a failing DB read',
        should: 'serve the cached count from memory',
        actual: usage.currentCount,
        expected: 2,
      });
    });
  });

  describe('resetUsage propagates DB failures and preserves memory', () => {
    it('rethrows the DB error and leaves the in-memory counter intact on failure', async () => {
      process.env.NODE_ENV = 'development';
      const cache = RateLimitCache.getInstance();

      // Seed a dev-mode memory entry so we can observe that a failed DB
      // delete does NOT clear it.
      await cache.incrementUsage('user-reset-fail', 'standard', 10);
      const before = (await cache.getCurrentUsage('user-reset-fail', 'standard', 10))
        .currentCount;

      vi.spyOn(db, 'delete').mockImplementation(() => {
        throw new Error('DB unavailable');
      });

      let thrown: Error | null = null;
      try {
        await cache.resetUsage('user-reset-fail', 'standard');
      } catch (error) {
        thrown = error as Error;
      }

      // Remove the mock so we can inspect state without hitting the broken path.
      vi.restoreAllMocks();
      const memoryAfter = (
        await cache.getCurrentUsage('user-reset-fail', 'standard', 10)
      ).currentCount;

      assert({
        given: 'a DB delete that throws during resetUsage',
        should: 'rethrow the DB error and leave memory untouched',
        actual: { threw: thrown?.message, before, memoryAfter },
        expected: { threw: 'DB unavailable', before: 1, memoryAfter: 1 },
      });
    });
  });

  describe('clearAll propagates DB failures and preserves memory', () => {
    it('rethrows the DB error and leaves the in-memory cache intact on failure', async () => {
      process.env.NODE_ENV = 'development';
      const cache = RateLimitCache.getInstance();

      await cache.incrementUsage('user-clear-fail-a', 'standard', 10);
      await cache.incrementUsage('user-clear-fail-b', 'pro', 10);
      const statsBefore = cache.getCacheStats().memoryEntries;

      vi.spyOn(db, 'delete').mockImplementation(() => {
        throw new Error('DB unavailable');
      });

      let thrown: Error | null = null;
      try {
        await cache.clearAll();
      } catch (error) {
        thrown = error as Error;
      }

      const statsAfter = cache.getCacheStats().memoryEntries;

      assert({
        given: 'a DB delete that throws during clearAll',
        should: 'rethrow and leave the in-memory cache entries intact',
        actual: {
          threw: thrown?.message,
          memoryBefore: statsBefore,
          memoryAfter: statsAfter,
        },
        expected: { threw: 'DB unavailable', memoryBefore: 2, memoryAfter: 2 },
      });
    });
  });

  describe('getCacheStats', () => {
    it('reports unknown health before any DB op, then tracks observed outcomes', async () => {
      const cache = RateLimitCache.getInstance();
      const initial = cache.getCacheStats();

      await cache.incrementUsage('user-stats', 'standard', 10);
      const afterSuccess = cache.getCacheStats();

      process.env.NODE_ENV = 'development';
      vi.spyOn(db, 'insert').mockImplementation(() => {
        throw new Error('DB unavailable');
      });
      await cache.incrementUsage('user-stats', 'standard', 10);
      const afterFailure = cache.getCacheStats();

      assert({
        given: 'stats snapshots before/after a successful op and after a failing op',
        should:
          'move dbAvailable from null → true → false and always report dbConfigured per DATABASE_URL',
        actual: {
          initial: { dbAvailable: initial.dbAvailable, dbConfigured: initial.dbConfigured },
          afterSuccess: {
            dbAvailable: afterSuccess.dbAvailable,
            dbConfigured: afterSuccess.dbConfigured,
          },
          afterFailure: {
            dbAvailable: afterFailure.dbAvailable,
            dbConfigured: afterFailure.dbConfigured,
          },
        },
        expected: {
          initial: { dbAvailable: null, dbConfigured: true },
          afterSuccess: { dbAvailable: true, dbConfigured: true },
          afterFailure: { dbAvailable: false, dbConfigured: true },
        },
      });
    });
  });
});

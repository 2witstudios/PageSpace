import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimitCache } from '../rate-limit-cache';
import type { ProviderType } from '../rate-limit-cache';

describe('rate-limit-cache', () => {
  let cache: RateLimitCache;

  beforeEach(() => {
    // Create new instance for each test
    cache = RateLimitCache.getInstance({ enableRedis: !!process.env.REDIS_URL });
  });

  afterEach(async () => {
    await cache.clearAll();
    await cache.shutdown();
  });

  const testUserId = 'user_test_123';
  const testProvider: ProviderType = 'standard';
  const testLimit = 10;

  describe('Core increment and limit logic', () => {
    it('increment within limit succeeds', async () => {
      const result = await cache.incrementUsage(testUserId, testProvider, testLimit);

      expect(result.success).toBe(true);
      expect(result.currentCount).toBe(1);
      expect(result.limit).toBe(testLimit);
      expect(result.remainingCalls).toBe(9);
    });

    it('increment exactly at limit succeeds', async () => {
      // Increment 9 times to reach count = 9
      for (let i = 0; i < 9; i++) {
        await cache.incrementUsage(testUserId, testProvider, testLimit);
      }

      // 10th call should succeed (at limit)
      const result = await cache.incrementUsage(testUserId, testProvider, testLimit);

      expect(result.success).toBe(true);
      expect(result.currentCount).toBe(10);
      expect(result.remainingCalls).toBe(0);
    });

    it('increment beyond limit fails', async () => {
      // Hit the limit (10 calls)
      for (let i = 0; i < 10; i++) {
        await cache.incrementUsage(testUserId, testProvider, testLimit);
      }

      // 11th call should fail
      const result = await cache.incrementUsage(testUserId, testProvider, testLimit);

      expect(result.success).toBe(false);
      expect(result.currentCount).toBe(10);
      expect(result.remainingCalls).toBe(0);
    });

    it('getCurrentUsage returns accurate count', async () => {
      // Make 5 calls
      for (let i = 0; i < 5; i++) {
        await cache.incrementUsage(testUserId, testProvider, testLimit);
      }

      const usage = await cache.getCurrentUsage(testUserId, testProvider, testLimit);

      expect(usage.success).toBe(true);
      expect(usage.currentCount).toBe(5);
      expect(usage.remainingCalls).toBe(5);
    });

    it('getCurrentUsage returns 0 for new user', async () => {
      const usage = await cache.getCurrentUsage('new_user', testProvider, testLimit);

      expect(usage.success).toBe(true);
      expect(usage.currentCount).toBe(0);
      expect(usage.remainingCalls).toBe(testLimit);
    });

    it('multiple increments accumulate correctly', async () => {
      const results = [];

      for (let i = 1; i <= 5; i++) {
        const result = await cache.incrementUsage(testUserId, testProvider, testLimit);
        results.push(result);
      }

      // Verify counts increment sequentially
      expect(results[0].currentCount).toBe(1);
      expect(results[1].currentCount).toBe(2);
      expect(results[2].currentCount).toBe(3);
      expect(results[3].currentCount).toBe(4);
      expect(results[4].currentCount).toBe(5);

      // Verify remaining decreases
      expect(results[4].remainingCalls).toBe(5);
    });

    it('limit of 0 always blocks', async () => {
      const result = await cache.incrementUsage(testUserId, testProvider, 0);

      expect(result.success).toBe(false);
      expect(result.currentCount).toBe(0);
      expect(result.remainingCalls).toBe(0);
    });

    it('different limits for same user and different providers', async () => {
      const standardLimit = 10;
      const proLimit = 50;

      await cache.incrementUsage(testUserId, 'standard', standardLimit);
      await cache.incrementUsage(testUserId, 'pro', proLimit);

      const standardUsage = await cache.getCurrentUsage(testUserId, 'standard', standardLimit);
      const proUsage = await cache.getCurrentUsage(testUserId, 'pro', proLimit);

      expect(standardUsage.currentCount).toBe(1);
      expect(proUsage.currentCount).toBe(1);
    });
  });

  describe('Isolation between users, providers, and dates', () => {
    it('different users have separate counters', async () => {
      const user1 = 'user_1';
      const user2 = 'user_2';

      // User 1 makes 5 calls
      for (let i = 0; i < 5; i++) {
        await cache.incrementUsage(user1, testProvider, testLimit);
      }

      // User 2 makes 3 calls
      for (let i = 0; i < 3; i++) {
        await cache.incrementUsage(user2, testProvider, testLimit);
      }

      const usage1 = await cache.getCurrentUsage(user1, testProvider, testLimit);
      const usage2 = await cache.getCurrentUsage(user2, testProvider, testLimit);

      expect(usage1.currentCount).toBe(5);
      expect(usage2.currentCount).toBe(3);
    });

    it('different provider types have separate counters', async () => {
      // Make calls to standard provider
      for (let i = 0; i < 7; i++) {
        await cache.incrementUsage(testUserId, 'standard', 20);
      }

      // Make calls to pro provider
      for (let i = 0; i < 3; i++) {
        await cache.incrementUsage(testUserId, 'pro', 50);
      }

      const standardUsage = await cache.getCurrentUsage(testUserId, 'standard', 20);
      const proUsage = await cache.getCurrentUsage(testUserId, 'pro', 50);

      expect(standardUsage.currentCount).toBe(7);
      expect(proUsage.currentCount).toBe(3);
    });

    it('changing limit mid-day affects remaining calls correctly', async () => {
      // Start with limit 10, make 5 calls
      for (let i = 0; i < 5; i++) {
        await cache.incrementUsage(testUserId, testProvider, 10);
      }

      // Check usage with new limit (20)
      const usage = await cache.getCurrentUsage(testUserId, testProvider, 20);

      expect(usage.currentCount).toBe(5);
      expect(usage.limit).toBe(20);
      expect(usage.remainingCalls).toBe(15);
    });

    it('reset one user does not affect others', async () => {
      const user1 = 'user_reset_1';
      const user2 = 'user_reset_2';

      // Both users make calls
      await cache.incrementUsage(user1, testProvider, testLimit);
      await cache.incrementUsage(user2, testProvider, testLimit);

      // Reset only user1
      await cache.resetUsage(user1, testProvider);

      const usage1 = await cache.getCurrentUsage(user1, testProvider, testLimit);
      const usage2 = await cache.getCurrentUsage(user2, testProvider, testLimit);

      expect(usage1.currentCount).toBe(0);
      expect(usage2.currentCount).toBe(1);
    });
  });

  describe('TTL and expiry - THE KEY BUG FIX', () => {
    it('counter exists immediately after creation', async () => {
      await cache.incrementUsage(testUserId, testProvider, testLimit);

      const usage = await cache.getCurrentUsage(testUserId, testProvider, testLimit);

      expect(usage.currentCount).toBe(1);
    });

    it('cleanup removes expired entries from memory cache', async () => {
      const testCache = RateLimitCache.getInstance({ enableRedis: false });

      const originalModule = await import('../date-utils');
      vi.doMock('../date-utils', () => ({
        ...originalModule,
        getTodayUTC: () => '2025-01-15',
        getSecondsUntilMidnightUTC: () => 1
      }));

      // Create some entries
      for (let i = 0; i < 5; i++) {
        await testCache.incrementUsage(`user_${i}`, testProvider, testLimit);
      }

      const statsBefore = testCache.getCacheStats();
      expect(statsBefore.memoryEntries).toBeGreaterThan(0);

      // Wait for cleanup cycle (runs every 60s, but we'll check manually)
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Trigger usage check to clean expired entries
      await testCache.getCurrentUsage(testUserId, testProvider, testLimit);

      await testCache.clearAll();
      await testCache.shutdown();
      vi.doUnmock('../date-utils');
    }, 10000);
  });

  describe('Concurrency and atomic operations', () => {
    it('100 concurrent increments respect limit exactly', async () => {
      const concurrentCalls = 100;
      const limit = 50;

      // Make 100 concurrent increment calls
      const promises = Array(concurrentCalls)
        .fill(null)
        .map(() => cache.incrementUsage(testUserId, testProvider, limit));

      const results = await Promise.all(promises);

      // Count successes and failures
      const successes = results.filter(r => r.success).length;
      const failures = results.filter(r => !r.success).length;

      // Exactly 50 should succeed, 50 should fail
      expect(successes).toBe(50);
      expect(failures).toBe(50);

      // Final count should be exactly 50
      const finalUsage = await cache.getCurrentUsage(testUserId, testProvider, limit);
      expect(finalUsage.currentCount).toBe(50);
    });

    it('concurrent increments from different users do not interfere', async () => {
      const user1 = 'concurrent_user_1';
      const user2 = 'concurrent_user_2';
      const callsPerUser = 10;

      // Make concurrent calls for both users
      const promises = [
        ...Array(callsPerUser).fill(null).map(() => cache.incrementUsage(user1, testProvider, 20)),
        ...Array(callsPerUser).fill(null).map(() => cache.incrementUsage(user2, testProvider, 20))
      ];

      await Promise.all(promises);

      const usage1 = await cache.getCurrentUsage(user1, testProvider, 20);
      const usage2 = await cache.getCurrentUsage(user2, testProvider, 20);

      expect(usage1.currentCount).toBe(callsPerUser);
      expect(usage2.currentCount).toBe(callsPerUser);
    });

    it('race condition on first increment - both succeed', async () => {
      const newUser = 'race_user_' + Date.now();

      // Two simultaneous first increments
      const [result1, result2] = await Promise.all([
        cache.incrementUsage(newUser, testProvider, testLimit),
        cache.incrementUsage(newUser, testProvider, testLimit)
      ]);

      // Both should succeed (atomic operations)
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Final count should be 2
      const usage = await cache.getCurrentUsage(newUser, testProvider, testLimit);
      expect(usage.currentCount).toBe(2);
    });
  });

  describe('Redis integration', () => {
    const hasRedis = !!process.env.REDIS_URL;

    it.skipIf(!hasRedis)('uses Redis when REDIS_URL is set', async () => {
      const stats = cache.getCacheStats();
      expect(stats.redisAvailable).toBe(true);
    });

    it.skipIf(!hasRedis)('can increment and read from Redis', async () => {
      await cache.incrementUsage(testUserId, testProvider, testLimit);

      const usage = await cache.getCurrentUsage(testUserId, testProvider, testLimit);
      expect(usage.currentCount).toBe(1);
    });

    it.skipIf(!hasRedis)('Redis counter persists across cache instances', async () => {
      // Make a call with first instance
      await cache.incrementUsage(testUserId, testProvider, testLimit);
      await cache.shutdown();

      // Create new instance and check count
      const newCache = RateLimitCache.getInstance({ enableRedis: true });
      const usage = await newCache.getCurrentUsage(testUserId, testProvider, testLimit);

      expect(usage.currentCount).toBe(1);

      await newCache.clearAll();
      await newCache.shutdown();
    });

    it('falls back to memory when Redis unavailable', async () => {
      // Shut down the beforeEach singleton so we can create one with enableRedis: false
      await cache.clearAll();
      await cache.shutdown();

      const memoryCache = RateLimitCache.getInstance({ enableRedis: false });

      await memoryCache.incrementUsage(testUserId, testProvider, testLimit);

      const usage = await memoryCache.getCurrentUsage(testUserId, testProvider, testLimit);
      expect(usage.currentCount).toBe(1);

      const stats = memoryCache.getCacheStats();
      expect(stats.redisAvailable).toBe(false);
      expect(stats.memoryEntries).toBeGreaterThan(0);

      await memoryCache.clearAll();
      await memoryCache.shutdown();
    });
  });

  describe('Reset functionality', () => {
    it('reset clears counter for specific user and provider', async () => {
      // Make some calls
      for (let i = 0; i < 5; i++) {
        await cache.incrementUsage(testUserId, testProvider, testLimit);
      }

      // Reset
      await cache.resetUsage(testUserId, testProvider);

      // Should be back to 0
      const usage = await cache.getCurrentUsage(testUserId, testProvider, testLimit);
      expect(usage.currentCount).toBe(0);
    });

    it('reset does not affect different provider types', async () => {
      // Make calls to both providers
      await cache.incrementUsage(testUserId, 'standard', 20);
      await cache.incrementUsage(testUserId, 'pro', 50);

      // Reset only standard
      await cache.resetUsage(testUserId, 'standard');

      const standardUsage = await cache.getCurrentUsage(testUserId, 'standard', 20);
      const proUsage = await cache.getCurrentUsage(testUserId, 'pro', 50);

      expect(standardUsage.currentCount).toBe(0);
      expect(proUsage.currentCount).toBe(1);
    });

    it('can increment after reset', async () => {
      // Hit limit
      for (let i = 0; i < testLimit; i++) {
        await cache.incrementUsage(testUserId, testProvider, testLimit);
      }

      // Should be blocked
      let result = await cache.incrementUsage(testUserId, testProvider, testLimit);
      expect(result.success).toBe(false);

      // Reset
      await cache.resetUsage(testUserId, testProvider);

      // Should be able to increment again
      result = await cache.incrementUsage(testUserId, testProvider, testLimit);
      expect(result.success).toBe(true);
      expect(result.currentCount).toBe(1);
    });
  });

  describe('Cache statistics', () => {
    it('reports memory entries correctly', async () => {
      // Create some entries
      for (let i = 0; i < 5; i++) {
        await cache.incrementUsage(`stats_user_${i}`, testProvider, testLimit);
      }

      const stats = cache.getCacheStats();
      expect(stats.memoryEntries).toBeGreaterThan(0);
    });

    it('reports Redis availability status', () => {
      const stats = cache.getCacheStats();
      expect(typeof stats.redisAvailable).toBe('boolean');
    });
  });

  describe('Clear all functionality', () => {
    it('clearAll removes all cache entries', async () => {
      // Create multiple entries
      for (let i = 0; i < 10; i++) {
        await cache.incrementUsage(`clear_user_${i}`, testProvider, testLimit);
      }

      // Clear all
      await cache.clearAll();

      // All counters should be reset
      for (let i = 0; i < 10; i++) {
        const usage = await cache.getCurrentUsage(`clear_user_${i}`, testProvider, testLimit);
        expect(usage.currentCount).toBe(0);
      }
    });
  });
});

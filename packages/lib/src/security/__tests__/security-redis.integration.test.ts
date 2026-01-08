/**
 * Security Redis Integration Tests
 *
 * Tests against real Redis when available. Skips gracefully when Redis is not running.
 *
 * To run these tests with Redis:
 *   1. Start Redis test container: docker compose -f docker-compose.test.yml up -d redis-test
 *   2. Run tests: REDIS_URL=redis://localhost:6380 pnpm vitest run src/security/__tests__/security-redis.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import Redis from 'ioredis';

// Integration test configuration
const REDIS_TEST_URL = process.env.REDIS_URL || 'redis://localhost:6380';

describe('security-redis integration', () => {
  let redis: Redis | null = null;

  beforeAll(async () => {
    // Attempt to connect to Redis - tests skip gracefully if unavailable
    try {
      redis = new Redis(REDIS_TEST_URL, {
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        lazyConnect: true,
      });
      await redis.ping();
    } catch {
      redis = null;
    }
  });

  afterAll(async () => {
    if (redis) {
      // Cleanup test keys
      const keys = await redis.keys('sec:test:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      await redis.quit();
    }
  });

  beforeEach(async () => {
    if (redis) {
      // Clean up any test keys before each test
      const keys = await redis.keys('sec:test:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    }
  });

  describe('JTI Operations with real Redis', () => {
    it('stores and retrieves JTI data with TTL', async () => {
      if (!redis) return;

      const jti = 'test-jti-' + Date.now();
      const key = `sec:test:jti:${jti}`;

      // Store JTI with 10 second TTL
      await redis.setex(key, 10, JSON.stringify({
        status: 'valid',
        userId: 'user-123',
        createdAt: Date.now(),
      }));

      // Verify stored data
      const stored = await redis.get(key);
      expect(stored).toBeTruthy();

      const data = JSON.parse(stored!);
      expect(data.status).toBe('valid');
      expect(data.userId).toBe('user-123');

      // Verify TTL is set
      const ttl = await redis.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(10);
    });

    it('revocation preserves TTL', async () => {
      if (!redis) return;

      const jti = 'test-jti-revoke-' + Date.now();
      const key = `sec:test:jti:${jti}`;

      // Store with 60 second TTL
      await redis.setex(key, 60, JSON.stringify({
        status: 'valid',
        userId: 'user-123',
        createdAt: Date.now(),
      }));

      // Get current TTL
      const originalTtl = await redis.ttl(key);

      // Revoke with remaining TTL
      await redis.setex(key, originalTtl, JSON.stringify({
        status: 'revoked',
        userId: 'user-123',
        revokedAt: Date.now(),
        reason: 'test revocation',
      }));

      // Verify revocation
      const stored = await redis.get(key);
      const data = JSON.parse(stored!);
      expect(data.status).toBe('revoked');
      expect(data.reason).toBe('test revocation');

      // TTL should still be close to original
      const newTtl = await redis.ttl(key);
      expect(newTtl).toBeGreaterThan(50);
    });
  });

  describe('Rate Limiting with real Redis', () => {
    it('sliding window algorithm works correctly', async () => {
      if (!redis) return;

      const key = 'sec:test:rate:sliding-' + Date.now();
      const windowMs = 10000; // 10 seconds
      const limit = 5;

      // Simulate sliding window rate limiting
      for (let i = 0; i < limit; i++) {
        const now = Date.now();
        const windowStart = now - windowMs;

        const pipeline = redis.pipeline();
        pipeline.zremrangebyscore(key, 0, windowStart);
        pipeline.zadd(key, now, `${now}-${Math.random().toString(36).slice(2)}`);
        pipeline.zcard(key);
        pipeline.pexpire(key, windowMs);

        const results = await pipeline.exec();
        const count = results?.[2]?.[1] as number;

        expect(count).toBe(i + 1);
        expect(count).toBeLessThanOrEqual(limit);
      }

      // 6th request should exceed limit
      const now = Date.now();
      const windowStart = now - windowMs;

      const pipeline = redis.pipeline();
      pipeline.zremrangebyscore(key, 0, windowStart);
      pipeline.zadd(key, now, `${now}-${Math.random().toString(36).slice(2)}`);
      pipeline.zcard(key);
      pipeline.pexpire(key, windowMs);

      const results = await pipeline.exec();
      const count = results?.[2]?.[1] as number;

      expect(count).toBe(limit + 1);
    });

    it('separate keys maintain separate limits', async () => {
      if (!redis) return;

      const key1 = 'sec:test:rate:user1-' + Date.now();
      const key2 = 'sec:test:rate:user2-' + Date.now();

      // Add 3 entries to key1
      for (let i = 0; i < 3; i++) {
        await redis.zadd(key1, Date.now(), `entry-${i}`);
      }

      // Add 1 entry to key2
      await redis.zadd(key2, Date.now(), 'entry-0');

      // Verify counts are independent
      const count1 = await redis.zcard(key1);
      const count2 = await redis.zcard(key2);

      expect(count1).toBe(3);
      expect(count2).toBe(1);
    });

    it('expired entries are removed from window', async () => {
      if (!redis) return;

      const key = 'sec:test:rate:expiry-' + Date.now();
      const now = Date.now();

      // Add old entry (outside window)
      await redis.zadd(key, now - 20000, 'old-entry');

      // Add current entry
      await redis.zadd(key, now, 'new-entry');

      // Clean up entries older than 10 seconds
      await redis.zremrangebyscore(key, 0, now - 10000);

      // Only new entry should remain
      const count = await redis.zcard(key);
      expect(count).toBe(1);

      const members = await redis.zrange(key, 0, -1);
      expect(members).toContain('new-entry');
      expect(members).not.toContain('old-entry');
    });
  });

  describe('Session Operations with real Redis', () => {
    it('stores and retrieves session data', async () => {
      if (!redis) return;

      const sessionId = 'test-session-' + Date.now();
      const key = `sec:test:session:${sessionId}`;

      const sessionData = {
        userId: 'user-456',
        role: 'admin',
        permissions: ['read', 'write', 'delete'],
      };

      // Store session with 1 hour TTL
      await redis.setex(key, 3600, JSON.stringify(sessionData));

      // Retrieve and verify
      const stored = await redis.get(key);
      const data = JSON.parse(stored!);

      expect(data.userId).toBe('user-456');
      expect(data.role).toBe('admin');
      expect(data.permissions).toEqual(['read', 'write', 'delete']);
    });

    it('session deletion works correctly', async () => {
      if (!redis) return;

      const sessionId = 'test-session-delete-' + Date.now();
      const key = `sec:test:session:${sessionId}`;

      // Store session
      await redis.setex(key, 3600, JSON.stringify({ userId: 'user-789' }));

      // Verify it exists
      expect(await redis.exists(key)).toBe(1);

      // Delete
      await redis.del(key);

      // Verify deletion
      expect(await redis.exists(key)).toBe(0);
    });
  });

  describe('Health Check', () => {
    it('ping returns PONG', async () => {
      if (!redis) return;

      const result = await redis.ping();
      expect(result).toBe('PONG');
    });

    it('measures latency accurately', async () => {
      if (!redis) return;

      const start = Date.now();
      await redis.ping();
      const latency = Date.now() - start;

      // Latency should be reasonable (< 100ms for local Redis)
      expect(latency).toBeLessThan(100);
      expect(latency).toBeGreaterThanOrEqual(0);
    });
  });
});

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock security-redis module
vi.mock('../security-redis', () => ({
  checkRateLimit: vi.fn(),
  resetRateLimit: vi.fn(),
  getRateLimitStatus: vi.fn(),
  tryGetRateLimitRedisClient: vi.fn(),
}));

// Mock logger
vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  getDistributedRateLimitStatus,
  initializeDistributedRateLimiting,
  shutdownRateLimiting,
  DISTRIBUTED_RATE_LIMITS,
  type RateLimitConfig,
} from '../distributed-rate-limit';
import {
  checkRateLimit as redisCheckRateLimit,
  resetRateLimit as redisResetRateLimit,
  getRateLimitStatus as redisGetRateLimitStatus,
  tryGetRateLimitRedisClient,
} from '../security-redis';

describe('distributed-rate-limit', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('checkDistributedRateLimit', () => {
    const testConfig: RateLimitConfig = {
      maxAttempts: 5,
      windowMs: 60000,
    };

    describe('with Redis available', () => {
      beforeEach(() => {
        vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue({} as never);
      });

      it('allows requests within limit', async () => {
        vi.mocked(redisCheckRateLimit).mockResolvedValue({
          allowed: true,
          remaining: 4,
          resetAt: new Date(Date.now() + 60000),
          totalCount: 1,
        });

        const result = await checkDistributedRateLimit('test-key', testConfig);

        expect(result.allowed).toBe(true);
        expect(result.attemptsRemaining).toBe(4);
      });

      it('blocks requests when limit exceeded', async () => {
        const resetAt = new Date(Date.now() + 30000);
        vi.mocked(redisCheckRateLimit).mockResolvedValue({
          allowed: false,
          remaining: 0,
          resetAt,
          totalCount: 6,
        });

        const result = await checkDistributedRateLimit('test-key', testConfig);

        expect(result.allowed).toBe(false);
        expect(result.retryAfter).toBeGreaterThan(0);
        expect(result.retryAfter).toBeLessThanOrEqual(30);
      });

      it('calls Redis with correct parameters', async () => {
        vi.mocked(redisCheckRateLimit).mockResolvedValue({
          allowed: true,
          remaining: 4,
          resetAt: new Date(),
          totalCount: 1,
        });

        await checkDistributedRateLimit('my-identifier', {
          maxAttempts: 10,
          windowMs: 120000,
        });

        expect(redisCheckRateLimit).toHaveBeenCalledWith('my-identifier', 10, 120000);
      });

      it('applies progressive delay when configured', async () => {
        vi.mocked(redisCheckRateLimit).mockResolvedValue({
          allowed: false,
          remaining: 0,
          resetAt: new Date(Date.now() + 60000),
          totalCount: 8, // 3 excess attempts (limit was 5)
        });

        const result = await checkDistributedRateLimit('progressive-key', {
          maxAttempts: 5,
          windowMs: 60000,
          blockDurationMs: 1000,
          progressiveDelay: true,
        });

        expect(result.allowed).toBe(false);
        // Progressive delay: 1000 * 2^2 = 4000ms = 4 seconds
        expect(result.retryAfter).toBeGreaterThan(1);
      });

      it('caps progressive delay at 30 minutes', async () => {
        vi.mocked(redisCheckRateLimit).mockResolvedValue({
          allowed: false,
          remaining: 0,
          resetAt: new Date(Date.now() + 60000),
          totalCount: 50, // Many excess attempts
        });

        const result = await checkDistributedRateLimit('capped-key', {
          maxAttempts: 5,
          windowMs: 60000,
          blockDurationMs: 60000,
          progressiveDelay: true,
        });

        expect(result.allowed).toBe(false);
        // Should be capped at 30 minutes (1800 seconds)
        expect(result.retryAfter).toBeLessThanOrEqual(1800);
      });
    });

    describe('with Redis unavailable', () => {
      beforeEach(() => {
        vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue(null);
      });

      it('falls back to in-memory rate limiting in development', async () => {
        process.env.NODE_ENV = 'development';
        const result = await checkDistributedRateLimit('fallback-test', testConfig);

        expect(result.allowed).toBe(true);
        expect(result.attemptsRemaining).toBe(4);
      });

      it('in-memory rate limiting works correctly in development', async () => {
        process.env.NODE_ENV = 'development';
        // Make 5 requests (limit)
        for (let i = 0; i < 5; i++) {
          await checkDistributedRateLimit('memory-test', testConfig);
        }

        // 6th should be blocked
        const result = await checkDistributedRateLimit('memory-test', testConfig);
        expect(result.allowed).toBe(false);
        expect(result.retryAfter).toBeGreaterThan(0);
      });

      it('denies requests in production when Redis unavailable (fail-closed)', async () => {
        process.env.NODE_ENV = 'production';
        const { loggers } = await import('../../logging/logger-config');

        const result = await checkDistributedRateLimit('prod-fallback', testConfig);

        expect(result.allowed).toBe(false);
        expect(result.retryAfter).toBe(60);
        expect(result.attemptsRemaining).toBe(0);
        expect(loggers.api.error).toHaveBeenCalledWith(
          'Redis unavailable in production - DENYING request (fail-closed)',
          expect.any(Object)
        );
      });
    });

    describe('Redis error handling', () => {
      it('falls back to in-memory on Redis error in development', async () => {
        process.env.NODE_ENV = 'development';
        vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue({} as never);
        vi.mocked(redisCheckRateLimit).mockRejectedValue(new Error('Redis connection lost'));

        const { loggers } = await import('../../logging/logger-config');
        const result = await checkDistributedRateLimit('error-test', testConfig);

        expect(result.allowed).toBe(true);
        expect(loggers.api.warn).toHaveBeenCalledWith(
          'Redis rate limit check failed, falling back to in-memory',
          expect.any(Object)
        );
      });

      it('denies request on Redis error in production (fail-closed)', async () => {
        process.env.NODE_ENV = 'production';
        vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue({} as never);
        vi.mocked(redisCheckRateLimit).mockRejectedValue(new Error('Redis connection lost'));

        const { loggers } = await import('../../logging/logger-config');
        const result = await checkDistributedRateLimit('error-test-prod', testConfig);

        expect(result.allowed).toBe(false);
        expect(result.retryAfter).toBe(60);
        expect(loggers.api.warn).toHaveBeenCalledWith(
          'Redis rate limit check failed, falling back to in-memory',
          expect.any(Object)
        );
        expect(loggers.api.error).toHaveBeenCalledWith(
          'Redis unavailable in production - DENYING request (fail-closed)',
          expect.any(Object)
        );
      });
    });
  });

  describe('resetDistributedRateLimit', () => {
    it('resets both Redis and in-memory', async () => {
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue({} as never);

      await resetDistributedRateLimit('reset-key');

      expect(redisResetRateLimit).toHaveBeenCalledWith('reset-key');
    });

    it('handles Redis reset failure gracefully', async () => {
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue({} as never);
      vi.mocked(redisResetRateLimit).mockRejectedValue(new Error('Redis error'));

      // Should not throw
      await expect(resetDistributedRateLimit('fail-reset')).resolves.toBeUndefined();
    });

    it('works when Redis unavailable', async () => {
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue(null);

      // Should not throw
      await expect(resetDistributedRateLimit('no-redis')).resolves.toBeUndefined();
    });
  });

  describe('getDistributedRateLimitStatus', () => {
    const testConfig: RateLimitConfig = {
      maxAttempts: 5,
      windowMs: 60000,
    };

    it('returns status from Redis when available', async () => {
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue({} as never);
      vi.mocked(redisGetRateLimitStatus).mockResolvedValue({
        allowed: true,
        remaining: 3,
        resetAt: new Date(Date.now() + 30000),
        totalCount: 2,
      });

      const status = await getDistributedRateLimitStatus('status-key', testConfig);

      expect(status.blocked).toBe(false);
      expect(status.attemptsRemaining).toBe(3);
    });

    it('returns blocked status with retryAfter', async () => {
      const resetAt = new Date(Date.now() + 45000);
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue({} as never);
      vi.mocked(redisGetRateLimitStatus).mockResolvedValue({
        allowed: false,
        remaining: 0,
        resetAt,
        totalCount: 6,
      });

      const status = await getDistributedRateLimitStatus('blocked-key', testConfig);

      expect(status.blocked).toBe(true);
      expect(status.retryAfter).toBeGreaterThan(0);
      expect(status.retryAfter).toBeLessThanOrEqual(45);
    });

    it('falls back to in-memory when Redis unavailable in development', async () => {
      process.env.NODE_ENV = 'development';
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue(null);

      const status = await getDistributedRateLimitStatus('memory-status', testConfig);

      expect(status.blocked).toBe(false);
      expect(status.attemptsRemaining).toBe(5);
    });

    it('reports blocked in production when Redis unavailable (fail-closed)', async () => {
      process.env.NODE_ENV = 'production';
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue(null);

      const status = await getDistributedRateLimitStatus('prod-status', testConfig);

      expect(status.blocked).toBe(true);
      expect(status.retryAfter).toBe(60); // 60000ms / 1000 = 60s
      expect(status.attemptsRemaining).toBe(0);
    });
  });

  describe('initializeDistributedRateLimiting', () => {
    it('returns redis mode when Redis available', async () => {
      const mockRedis = { ping: vi.fn().mockResolvedValue('PONG') };
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue(mockRedis as never);

      const result = await initializeDistributedRateLimiting();

      expect(result.mode).toBe('redis');
      expect(result.error).toBeUndefined();
      expect(mockRedis.ping).toHaveBeenCalled();
    });

    it('returns memory mode in development when Redis unavailable', async () => {
      process.env.NODE_ENV = 'development';
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue(null);

      const result = await initializeDistributedRateLimiting();

      expect(result.mode).toBe('memory');
      expect(result.error).toBeUndefined();
    });

    it('throws error in production when Redis unavailable (fail-fast)', async () => {
      process.env.NODE_ENV = 'production';
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue(null);

      await expect(initializeDistributedRateLimiting()).rejects.toThrow(
        'Redis required for distributed rate limiting in production'
      );
    });

    it('throws error on Redis ping failure in production (fail-fast)', async () => {
      process.env.NODE_ENV = 'production';
      const mockRedis = { ping: vi.fn().mockRejectedValue(new Error('Connection refused')) };
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue(mockRedis as never);

      await expect(initializeDistributedRateLimiting()).rejects.toThrow('Connection refused');
    });

    it('handles Redis ping failure in development (no error returned)', async () => {
      process.env.NODE_ENV = 'development';
      const mockRedis = { ping: vi.fn().mockRejectedValue(new Error('Connection refused')) };
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue(mockRedis as never);

      const result = await initializeDistributedRateLimiting();

      expect(result.mode).toBe('memory');
      expect(result.error).toBeUndefined();
    });
  });

  describe('DISTRIBUTED_RATE_LIMITS', () => {
    it('LOGIN has reasonable limits with progressive delay', () => {
      expect(DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts).toBe(5);
      expect(DISTRIBUTED_RATE_LIMITS.LOGIN.windowMs).toBe(15 * 60 * 1000);
      expect(DISTRIBUTED_RATE_LIMITS.LOGIN.progressiveDelay).toBe(true);
    });

    it('SIGNUP has stricter limits', () => {
      expect(DISTRIBUTED_RATE_LIMITS.SIGNUP.maxAttempts).toBe(3);
      expect(DISTRIBUTED_RATE_LIMITS.SIGNUP.windowMs).toBe(60 * 60 * 1000);
    });

    it('PASSWORD_RESET matches SIGNUP limits', () => {
      expect(DISTRIBUTED_RATE_LIMITS.PASSWORD_RESET.maxAttempts).toBe(3);
      expect(DISTRIBUTED_RATE_LIMITS.PASSWORD_RESET.windowMs).toBe(60 * 60 * 1000);
    });

    it('REFRESH allows more attempts in shorter window', () => {
      expect(DISTRIBUTED_RATE_LIMITS.REFRESH.maxAttempts).toBe(10);
      expect(DISTRIBUTED_RATE_LIMITS.REFRESH.windowMs).toBe(5 * 60 * 1000);
    });

    it('API has high limit for normal operations', () => {
      expect(DISTRIBUTED_RATE_LIMITS.API.maxAttempts).toBe(100);
      expect(DISTRIBUTED_RATE_LIMITS.API.windowMs).toBe(60 * 1000);
    });

    it('FILE_UPLOAD has moderate limits', () => {
      expect(DISTRIBUTED_RATE_LIMITS.FILE_UPLOAD.maxAttempts).toBe(20);
      expect(DISTRIBUTED_RATE_LIMITS.FILE_UPLOAD.windowMs).toBe(60 * 1000);
    });

    it('SERVICE_TOKEN has high limit for automation', () => {
      expect(DISTRIBUTED_RATE_LIMITS.SERVICE_TOKEN.maxAttempts).toBe(1000);
      expect(DISTRIBUTED_RATE_LIMITS.SERVICE_TOKEN.windowMs).toBe(60 * 1000);
    });

    it('CONTACT_FORM has 5 attempts per hour', () => {
      expect(DISTRIBUTED_RATE_LIMITS.CONTACT_FORM.maxAttempts).toBe(5);
      expect(DISTRIBUTED_RATE_LIMITS.CONTACT_FORM.windowMs).toBe(60 * 60 * 1000);
      expect(DISTRIBUTED_RATE_LIMITS.CONTACT_FORM.progressiveDelay).toBe(false);
    });

    it('EMAIL_RESEND has 3 attempts per hour', () => {
      expect(DISTRIBUTED_RATE_LIMITS.EMAIL_RESEND.maxAttempts).toBe(3);
      expect(DISTRIBUTED_RATE_LIMITS.EMAIL_RESEND.windowMs).toBe(60 * 60 * 1000);
      expect(DISTRIBUTED_RATE_LIMITS.EMAIL_RESEND.progressiveDelay).toBe(false);
    });
  });

  describe('shutdownRateLimiting', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue(null);
    });

    it('clears in-memory rate limit data', async () => {
      const config: RateLimitConfig = { maxAttempts: 2, windowMs: 60000 };

      // Fill up rate limit
      await checkDistributedRateLimit('shutdown-test', config);
      await checkDistributedRateLimit('shutdown-test', config);

      // Should be blocked
      const blockedResult = await checkDistributedRateLimit('shutdown-test', config);
      expect(blockedResult.allowed).toBe(false);

      // Shutdown clears state
      shutdownRateLimiting();

      // Should work again after shutdown
      const afterShutdown = await checkDistributedRateLimit('shutdown-test', config);
      expect(afterShutdown.allowed).toBe(true);
    });

    it('is safe to call multiple times', () => {
      // Should not throw
      shutdownRateLimiting();
      shutdownRateLimiting();
      shutdownRateLimiting();
    });
  });

  describe('in-memory fallback isolation (development only)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
      vi.mocked(tryGetRateLimitRedisClient).mockResolvedValue(null);
    });

    it('maintains separate limits per identifier', async () => {
      const config: RateLimitConfig = { maxAttempts: 2, windowMs: 60000 };

      // Fill up user1
      await checkDistributedRateLimit('user1', config);
      await checkDistributedRateLimit('user1', config);

      // user1 should be blocked
      const result1 = await checkDistributedRateLimit('user1', config);
      expect(result1.allowed).toBe(false);

      // user2 should still work
      const result2 = await checkDistributedRateLimit('user2', config);
      expect(result2.allowed).toBe(true);
    });

    it('resets window after expiry', async () => {
      const config: RateLimitConfig = { maxAttempts: 1, windowMs: 50 };

      await checkDistributedRateLimit('expiry-test', config);
      const blocked = await checkDistributedRateLimit('expiry-test', config);
      expect(blocked.allowed).toBe(false);

      // Wait for window to expire
      await new Promise(resolve => setTimeout(resolve, 100));

      const afterExpiry = await checkDistributedRateLimit('expiry-test', config);
      expect(afterExpiry.allowed).toBe(true);
    });
  });
});

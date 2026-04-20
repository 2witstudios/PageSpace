import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const { insertMock, deleteMock, selectMock, executeMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  deleteMock: vi.fn(),
  selectMock: vi.fn(),
  executeMock: vi.fn(),
}));

vi.mock('@pagespace/db', () => {
  const noop = () => ({});
  const sqlFn = (() => ({})) as unknown;
  Object.assign(sqlFn as object, { raw: noop });
  return {
    db: {
      insert: insertMock,
      delete: deleteMock,
      select: selectMock,
      execute: executeMock,
    },
    rateLimitBuckets: { key: 'key', windowStart: 'window_start', count: 'count', expiresAt: 'expires_at' },
    sql: sqlFn,
    eq: () => ({}),
  };
});

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

// Build a chainable mock for db.insert(...).values(...).onConflictDoUpdate(...).returning()
function mockInsertReturning(count: number) {
  insertMock.mockReturnValue({
    values: () => ({
      onConflictDoUpdate: () => ({
        returning: async () => [{ count }],
      }),
    }),
  });
}

function mockInsertThrows(err: Error) {
  insertMock.mockImplementation(() => {
    throw err;
  });
}

function mockSelectReturns(count: number | null) {
  selectMock.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => (count === null ? [] : [{ count }]),
      }),
    }),
  });
}

function mockSelectThrows(err: Error) {
  selectMock.mockImplementation(() => {
    throw err;
  });
}

function mockDeleteResolves() {
  deleteMock.mockReturnValue({
    where: async () => ({}),
  });
}

describe('distributed-rate-limit', () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    shutdownRateLimiting();
    mockDeleteResolves();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('checkDistributedRateLimit', () => {
    const testConfig: RateLimitConfig = {
      maxAttempts: 5,
      windowMs: 60000,
    };

    describe('with Postgres available', () => {
      it('allows requests within limit', async () => {
        mockInsertReturning(1);
        const result = await checkDistributedRateLimit('test-key', testConfig);
        expect(result.allowed).toBe(true);
        expect(result.attemptsRemaining).toBe(4);
      });

      it('returns attemptsRemaining equal to maxAttempts - count', async () => {
        mockInsertReturning(3);
        const result = await checkDistributedRateLimit('test-key', testConfig);
        expect(result.allowed).toBe(true);
        expect(result.attemptsRemaining).toBe(2);
      });

      it('blocks requests when limit exceeded', async () => {
        mockInsertReturning(6);
        const result = await checkDistributedRateLimit('test-key', testConfig);
        expect(result.allowed).toBe(false);
        expect(result.retryAfter).toBe(60);
        expect(result.attemptsRemaining).toBe(0);
      });

      it('applies progressive delay when configured', async () => {
        mockInsertReturning(8); // 3 excess (limit 5)
        const result = await checkDistributedRateLimit('progressive-key', {
          maxAttempts: 5,
          windowMs: 60000,
          blockDurationMs: 1000,
          progressiveDelay: true,
        });
        expect(result.allowed).toBe(false);
        // 1000ms * 2^(3-1) = 4000ms → 4s
        expect(result.retryAfter).toBe(4);
      });

      it('caps progressive delay at 30 minutes', async () => {
        mockInsertReturning(100);
        const result = await checkDistributedRateLimit('capped-key', {
          maxAttempts: 5,
          windowMs: 60000,
          blockDurationMs: 60000,
          progressiveDelay: true,
        });
        expect(result.allowed).toBe(false);
        expect(result.retryAfter).toBeLessThanOrEqual(1800);
      });
    });

    describe('with Postgres unavailable', () => {
      it('falls back to in-memory rate limiting in development', async () => {
        process.env.NODE_ENV = 'development';
        mockInsertThrows(new Error('DB down'));

        const result = await checkDistributedRateLimit('fallback-test', testConfig);

        expect(result.allowed).toBe(true);
        expect(result.attemptsRemaining).toBe(4);
      });

      it('in-memory rate limiting blocks after limit in development', async () => {
        process.env.NODE_ENV = 'development';
        mockInsertThrows(new Error('DB down'));

        for (let i = 0; i < 5; i++) {
          await checkDistributedRateLimit('memory-test', testConfig);
        }

        const blocked = await checkDistributedRateLimit('memory-test', testConfig);
        expect(blocked.allowed).toBe(false);
        expect(blocked.retryAfter).toBeGreaterThan(0);
      });

      it('denies requests in production when DB unavailable (fail-closed)', async () => {
        process.env.NODE_ENV = 'production';
        mockInsertThrows(new Error('DB down'));

        const { loggers } = await import('../../logging/logger-config');
        const result = await checkDistributedRateLimit('prod-fallback', testConfig);

        expect(result.allowed).toBe(false);
        expect(result.retryAfter).toBe(60);
        expect(result.attemptsRemaining).toBe(0);
        expect(loggers.api.error).toHaveBeenCalledWith(
          'Postgres unavailable in production - DENYING request (fail-closed)',
          expect.any(Object)
        );
      });

      it('truncates long identifiers in the fail-closed log (safety)', async () => {
        process.env.NODE_ENV = 'production';
        mockInsertThrows(new Error('DB down'));

        const { loggers } = await import('../../logging/logger-config');
        const longId = 'x'.repeat(50);
        await checkDistributedRateLimit(longId, testConfig);

        expect(loggers.api.error).toHaveBeenCalledWith(
          'Postgres unavailable in production - DENYING request (fail-closed)',
          expect.objectContaining({ identifier: expect.stringContaining('...') })
        );
      });
    });
  });

  describe('resetDistributedRateLimit', () => {
    it('issues a DELETE against rate_limit_buckets for the identifier', async () => {
      mockDeleteResolves();
      await resetDistributedRateLimit('reset-key');
      expect(deleteMock).toHaveBeenCalled();
    });

    it('swallows DB errors without throwing', async () => {
      deleteMock.mockImplementation(() => {
        throw new Error('DB down');
      });
      await expect(resetDistributedRateLimit('fail-reset')).resolves.toBeUndefined();
    });
  });

  describe('getDistributedRateLimitStatus', () => {
    const testConfig: RateLimitConfig = {
      maxAttempts: 5,
      windowMs: 60000,
    };

    it('returns unblocked status when count < limit', async () => {
      mockSelectReturns(2);
      const status = await getDistributedRateLimitStatus('status-key', testConfig);
      expect(status.blocked).toBe(false);
      expect(status.attemptsRemaining).toBe(3);
    });

    it('returns blocked status with retryAfter when count >= limit', async () => {
      mockSelectReturns(6);
      const status = await getDistributedRateLimitStatus('blocked-key', testConfig);
      expect(status.blocked).toBe(true);
      expect(status.retryAfter).toBe(60);
      expect(status.attemptsRemaining).toBe(0);
    });

    it('reports unblocked and full remaining when no bucket yet', async () => {
      mockSelectReturns(null);
      const status = await getDistributedRateLimitStatus('fresh-key', testConfig);
      expect(status.blocked).toBe(false);
      expect(status.attemptsRemaining).toBe(5);
    });

    it('falls back to in-memory status in development when DB fails', async () => {
      process.env.NODE_ENV = 'development';
      mockSelectThrows(new Error('DB down'));

      const status = await getDistributedRateLimitStatus('memory-status', testConfig);
      expect(status.blocked).toBe(false);
      expect(status.attemptsRemaining).toBe(5);
    });

    it('reports blocked in production when DB unavailable (fail-closed)', async () => {
      process.env.NODE_ENV = 'production';
      mockSelectThrows(new Error('DB down'));

      const status = await getDistributedRateLimitStatus('prod-status', testConfig);
      expect(status.blocked).toBe(true);
      expect(status.retryAfter).toBe(60);
      expect(status.attemptsRemaining).toBe(0);
    });
  });

  describe('initializeDistributedRateLimiting', () => {
    it('returns postgres mode when DB is reachable', async () => {
      executeMock.mockResolvedValue({ rows: [{ '?column?': 1 }] });

      const result = await initializeDistributedRateLimiting();
      expect(result.mode).toBe('postgres');
      expect(result.error).toBeUndefined();
    });

    it('returns memory mode in development when DB is unreachable', async () => {
      process.env.NODE_ENV = 'development';
      executeMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await initializeDistributedRateLimiting();
      expect(result.mode).toBe('memory');
      expect(result.error).toBeUndefined();
    });

    it('throws in production when DB is unreachable (fail-fast)', async () => {
      process.env.NODE_ENV = 'production';
      executeMock.mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(initializeDistributedRateLimiting()).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('DISTRIBUTED_RATE_LIMITS', () => {
    it('LOGIN has reasonable limits with progressive delay', () => {
      expect(DISTRIBUTED_RATE_LIMITS.LOGIN.maxAttempts).toBe(5);
      expect(DISTRIBUTED_RATE_LIMITS.LOGIN.windowMs).toBe(15 * 60 * 1000);
      expect(DISTRIBUTED_RATE_LIMITS.LOGIN.progressiveDelay).toBe(true);
    });

    it('SIGNUP has strict limits', () => {
      expect(DISTRIBUTED_RATE_LIMITS.SIGNUP.maxAttempts).toBe(10);
      expect(DISTRIBUTED_RATE_LIMITS.SIGNUP.windowMs).toBe(60 * 60 * 1000);
    });

    it('PASSWORD_RESET allows 3 attempts per hour', () => {
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

    it('CONTACT_FORM has 10 attempts per minute', () => {
      expect(DISTRIBUTED_RATE_LIMITS.CONTACT_FORM.maxAttempts).toBe(10);
      expect(DISTRIBUTED_RATE_LIMITS.CONTACT_FORM.windowMs).toBe(60 * 1000);
      expect(DISTRIBUTED_RATE_LIMITS.CONTACT_FORM.progressiveDelay).toBe(false);
    });

    it('TRACKING has 100 attempts per minute', () => {
      expect(DISTRIBUTED_RATE_LIMITS.TRACKING.maxAttempts).toBe(100);
      expect(DISTRIBUTED_RATE_LIMITS.TRACKING.windowMs).toBe(60 * 1000);
      expect(DISTRIBUTED_RATE_LIMITS.TRACKING.progressiveDelay).toBe(false);
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
      mockInsertThrows(new Error('DB down'));
    });

    it('clears in-memory rate limit data', async () => {
      const config: RateLimitConfig = { maxAttempts: 2, windowMs: 60000 };

      await checkDistributedRateLimit('shutdown-test', config);
      await checkDistributedRateLimit('shutdown-test', config);
      const blocked = await checkDistributedRateLimit('shutdown-test', config);
      expect(blocked.allowed).toBe(false);

      shutdownRateLimiting();

      const afterShutdown = await checkDistributedRateLimit('shutdown-test', config);
      expect(afterShutdown.allowed).toBe(true);
    });

    it('is safe to call multiple times', () => {
      shutdownRateLimiting();
      shutdownRateLimiting();
      shutdownRateLimiting();
    });
  });

  describe('in-memory fallback isolation (development only)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'development';
      mockInsertThrows(new Error('DB down'));
    });

    it('maintains separate limits per identifier', async () => {
      const config: RateLimitConfig = { maxAttempts: 2, windowMs: 60000 };

      await checkDistributedRateLimit('user1', config);
      await checkDistributedRateLimit('user1', config);
      const result1 = await checkDistributedRateLimit('user1', config);
      expect(result1.allowed).toBe(false);

      const result2 = await checkDistributedRateLimit('user2', config);
      expect(result2.allowed).toBe(true);
    });

    it('resets window after expiry', async () => {
      const config: RateLimitConfig = { maxAttempts: 1, windowMs: 50 };

      await checkDistributedRateLimit('expiry-test', config);
      const blocked = await checkDistributedRateLimit('expiry-test', config);
      expect(blocked.allowed).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const afterExpiry = await checkDistributedRateLimit('expiry-test', config);
      expect(afterExpiry.allowed).toBe(true);
    });
  });
});

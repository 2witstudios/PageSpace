import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

const { insertMock, deleteMock, selectMock, executeMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  deleteMock: vi.fn(),
  selectMock: vi.fn(),
  executeMock: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: insertMock,
    delete: deleteMock,
    select: selectMock,
    execute: executeMock,
  },
}));
vi.mock('@pagespace/db/schema/rate-limit-buckets', () => ({
  rateLimitBuckets: { key: 'key', windowStart: 'window_start', count: 'count', expiresAt: 'expires_at' },
}));
vi.mock('@pagespace/db/operators', () => {
  const noop = () => ({});
  const sqlFn = (() => ({})) as unknown;
  Object.assign(sqlFn as object, { raw: noop });
  return {
    sql: sqlFn,
    eq: () => ({}),
    lt: () => ({}),
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
  conservativeFallbackMaxAttempts,
  conservativeFallbackConfig,
  conservativeFallbackCheck,
  sweepExpiredInMemoryAttempts,
  MAX_IN_MEMORY_ATTEMPT_ENTRIES,
  DISTRIBUTED_RATE_LIMITS,
  type RateLimitConfig,
} from '../distributed-rate-limit';

// Drizzle wraps driver errors: the pg fields (code, etc.) live on error.cause,
// not the top-level error. Throw the wrapper shape the real code sees so tests
// don't pass against a convenient flat error the production path never gets.
function drizzleWrappedPgError(pgMessage = 'connection refused'): Error {
  const cause = Object.assign(new Error(pgMessage), { code: 'ECONNREFUSED' });
  return Object.assign(
    new Error('Failed query: insert into "rate_limit_buckets" ...'),
    { cause },
  );
}

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

// Returns a different count for each sequential db.select(...) call in the
// order issued. Used when the code-under-test issues the current-bucket and
// previous-bucket reads in parallel (Promise.all) — they still execute in
// declaration order, so index 0 maps to curr, index 1 to prev.
function mockSelectSequence(...counts: (number | null)[]) {
  let i = 0;
  selectMock.mockImplementation(() => ({
    from: () => ({
      where: () => ({
        limit: async () => {
          const c = counts[Math.min(i, counts.length - 1)];
          i += 1;
          return c === null || c === undefined ? [] : [{ count: c }];
        },
      }),
    }),
  }));
}

function mockSelectThrows(err: Error) {
  selectMock.mockImplementation(() => {
    throw err;
  });
}

// Configures both reads a check() performs: the upserted current bucket (via
// insert..returning) and the read-only previous bucket (via select).
function mockCheckBuckets(currCount: number, prevCount: number = 0) {
  mockInsertReturning(currCount);
  mockSelectReturns(prevCount);
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
    // Default: no previous-bucket contribution unless a test overrides.
    mockSelectReturns(0);
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
        // Pin to start of bucket so msUntilWindowEnd = windowMs — the progressive
        // block (4000ms) stays well below the remaining-window clamp.
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(60_000);
        try {
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
        } finally {
          nowSpy.mockRestore();
        }
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

      it('clamps progressive retryAfter to remaining window time', async () => {
        // windowMs is 10s. Progressive formula at excess=5 gives 10000 * 2^4 = 160s.
        // The bucket resets in <= 10s, so retryAfter must not exceed 10.
        mockInsertReturning(10);
        const result = await checkDistributedRateLimit('clamp-key', {
          maxAttempts: 5,
          windowMs: 10_000,
          blockDurationMs: 10_000,
          progressiveDelay: true,
        });
        expect(result.allowed).toBe(false);
        expect(result.retryAfter).toBeGreaterThan(0);
        expect(result.retryAfter).toBeLessThanOrEqual(10);
      });

      it('clamps non-progressive retryAfter to remaining window time', async () => {
        // Non-progressive path also can't promise longer than the window resets.
        mockInsertReturning(6);
        const result = await checkDistributedRateLimit('clamp-non-progressive', {
          maxAttempts: 5,
          windowMs: 10_000,
        });
        expect(result.allowed).toBe(false);
        expect(result.retryAfter).toBeLessThanOrEqual(10);
      });

      it('prevents boundary bursting by weighting the previous bucket', async () => {
        // Classic fixed-window attack: prev bucket already at the limit, then
        // cross the boundary and try again. curr=1, prev=5 — a pure fixed-window
        // impl would allow this (new bucket, count=1 < 5). Weighted sliding
        // window must treat the prev count as still in the window near the boundary.
        //
        // Pin Date.now to a bucket boundary so prevWeight = 1, making
        // effective = 1 + 5*1 = 6 > 5 → blocked.
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(60_000);
        try {
          mockCheckBuckets(1, 5);
          const result = await checkDistributedRateLimit('boundary-burst', {
            maxAttempts: 5,
            windowMs: 60_000,
          });
          expect(result.allowed).toBe(false);
        } finally {
          nowSpy.mockRestore();
        }
      });

      it('allows fresh requests when there is no previous bucket', async () => {
        mockCheckBuckets(1, 0);
        const result = await checkDistributedRateLimit('fresh-bucket', {
          maxAttempts: 5,
          windowMs: 60_000,
        });
        expect(result.allowed).toBe(true);
        expect(result.attemptsRemaining).toBe(4);
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

      // testConfig.maxAttempts is 5 → conservative fallback threshold is
      // floor(5/2) = 2 per instance.
      describe('in production (conservative in-memory fallback)', () => {
        beforeEach(() => {
          process.env.NODE_ENV = 'production';
          mockInsertThrows(drizzleWrappedPgError());
        });

        it('allows initial requests instead of denying everything', async () => {
          const result = await checkDistributedRateLimit('prod-fallback', testConfig);

          expect(result.allowed).toBe(true);
          expect(result.attemptsRemaining).toBe(1);
        });

        it('denies requests past the conservative threshold', async () => {
          await checkDistributedRateLimit('prod-threshold', testConfig);
          await checkDistributedRateLimit('prod-threshold', testConfig);
          const blocked = await checkDistributedRateLimit('prod-threshold', testConfig);

          expect(blocked.allowed).toBe(false);
          expect(blocked.retryAfter).toBeGreaterThan(0);
        });

        it('logs a WARN with the RATE_LIMIT_PG_FALLBACK marker and truncated identifier', async () => {
          const { loggers } = await import('../../logging/logger-config');
          const longId = 'x'.repeat(50);
          await checkDistributedRateLimit(longId, testConfig);

          expect(loggers.api.warn).toHaveBeenCalledWith(
            expect.stringContaining('RATE_LIMIT_PG_FALLBACK'),
            expect.objectContaining({ identifier: expect.stringContaining('...') })
          );
          expect(loggers.api.error).not.toHaveBeenCalled();
        });

        it('preserves window semantics: fallback counts expire after windowMs', async () => {
          // maxAttempts 2 → conservative threshold 1.
          const config: RateLimitConfig = { maxAttempts: 2, windowMs: 50 };

          await checkDistributedRateLimit('prod-expiry', config);
          const blocked = await checkDistributedRateLimit('prod-expiry', config);
          expect(blocked.allowed).toBe(false);

          await new Promise((resolve) => setTimeout(resolve, 100));

          const afterExpiry = await checkDistributedRateLimit('prod-expiry', config);
          expect(afterExpiry.allowed).toBe(true);
        });

        it('resumes distributed enforcement after Postgres recovers, ignoring fallback counts', async () => {
          const { loggers } = await import('../../logging/logger-config');

          // Exhaust the conservative in-memory threshold during the outage.
          await checkDistributedRateLimit('prod-recovery', testConfig);
          await checkDistributedRateLimit('prod-recovery', testConfig);
          const blocked = await checkDistributedRateLimit('prod-recovery', testConfig);
          expect(blocked.allowed).toBe(false);

          // Postgres comes back: the distributed count (1) is authoritative and
          // the in-memory outage counts must not bleed into the decision.
          mockInsertReturning(1);
          const recovered = await checkDistributedRateLimit('prod-recovery', testConfig);
          expect(recovered.allowed).toBe(true);
          expect(recovered.attemptsRemaining).toBe(4);
          expect(loggers.api.info).toHaveBeenCalledWith(
            'Distributed rate limiting enabled (Postgres)'
          );
        });
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
      mockSelectSequence(2, 0);
      const status = await getDistributedRateLimitStatus('status-key', testConfig);
      expect(status.blocked).toBe(false);
      expect(status.attemptsRemaining).toBe(3);
    });

    it('returns blocked status with retryAfter when count >= limit', async () => {
      mockSelectSequence(6, 0);
      const status = await getDistributedRateLimitStatus('blocked-key', testConfig);
      expect(status.blocked).toBe(true);
      expect(status.retryAfter).toBe(60);
      expect(status.attemptsRemaining).toBe(0);
    });

    it('reports unblocked and full remaining when no bucket yet', async () => {
      mockSelectSequence(null, null);
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

    it('reports conservative in-memory status in production when DB unavailable', async () => {
      process.env.NODE_ENV = 'production';
      mockSelectThrows(drizzleWrappedPgError());

      // No attempts recorded → not blocked; remaining reflects the conservative
      // threshold (floor(5/2) = 2), not the configured 5.
      const status = await getDistributedRateLimitStatus('prod-status', testConfig);
      expect(status.blocked).toBe(false);
      expect(status.attemptsRemaining).toBe(2);
    });

    it('reports blocked in production once fallback attempts reach the conservative threshold', async () => {
      process.env.NODE_ENV = 'production';
      mockInsertThrows(drizzleWrappedPgError());
      mockSelectThrows(drizzleWrappedPgError());

      await checkDistributedRateLimit('prod-status-blocked', testConfig);
      await checkDistributedRateLimit('prod-status-blocked', testConfig);

      const status = await getDistributedRateLimitStatus('prod-status-blocked', testConfig);
      expect(status.blocked).toBe(true);
      expect(status.attemptsRemaining).toBe(0);
    });

    it('applies progressive delay formula in status, matching check', async () => {
      // Pin to start of bucket so msUntilWindowEnd doesn't clamp below 4000ms.
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(60_000);
      try {
        mockSelectSequence(8, 0); // 3 excess (limit 5), no prev contribution
        const status = await getDistributedRateLimitStatus('progressive-status', {
          maxAttempts: 5,
          windowMs: 60_000,
          blockDurationMs: 1_000,
          progressiveDelay: true,
        });
        expect(status.blocked).toBe(true);
        // 1000 * 2^(3-1) = 4000ms → 4s (within windowMs, no clamp)
        expect(status.retryAfter).toBe(4);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('clamps status retryAfter to remaining window time', async () => {
      mockSelectSequence(10, 0); // 5 excess
      const status = await getDistributedRateLimitStatus('progressive-clamp', {
        maxAttempts: 5,
        windowMs: 10_000,
        blockDurationMs: 10_000,
        progressiveDelay: true,
      });
      expect(status.blocked).toBe(true);
      expect(status.retryAfter).toBeGreaterThan(0);
      expect(status.retryAfter).toBeLessThanOrEqual(10);
    });

    it('includes weighted contribution from previous bucket', async () => {
      // Pin to bucket boundary: prevWeight = 1, effective = 1 + 10*1 = 11 → blocked.
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(60_000);
      try {
        mockSelectSequence(1, 10);
        const status = await getDistributedRateLimitStatus('weighted-status', {
          maxAttempts: 5,
          windowMs: 60_000,
        });
        expect(status.blocked).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }
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

    it('FORM_SUBMISSION has 10 attempts per minute with no progressive delay', () => {
      expect(DISTRIBUTED_RATE_LIMITS.FORM_SUBMISSION.maxAttempts).toBe(10);
      expect(DISTRIBUTED_RATE_LIMITS.FORM_SUBMISSION.windowMs).toBe(60 * 1000);
      expect(DISTRIBUTED_RATE_LIMITS.FORM_SUBMISSION.progressiveDelay).toBe(false);
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

  describe('in-memory fallback memory bounds', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
      mockInsertThrows(drizzleWrappedPgError());
    });

    it('sweeps entries once their window has fully elapsed, not on a fixed 25h cutoff', async () => {
      const t0 = 1_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
      try {
        const config: RateLimitConfig = { maxAttempts: 5, windowMs: 60_000 };
        await checkDistributedRateLimit('sweep-a', config);
        await checkDistributedRateLimit('sweep-b', config);
        await checkDistributedRateLimit('sweep-c', config);

        expect(sweepExpiredInMemoryAttempts(t0 + 59_999)).toBe(0);
        expect(sweepExpiredInMemoryAttempts(t0 + 60_000)).toBe(3);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('does not sweep an actively blocked entry before its block expires', async () => {
      const t0 = 1_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
      try {
        // maxAttempts 2 → conservative threshold 1; second check trips the
        // 10-minute block, which outlives the 1s window.
        const config: RateLimitConfig = {
          maxAttempts: 2,
          windowMs: 1_000,
          blockDurationMs: 600_000,
        };
        await checkDistributedRateLimit('sweep-blocked', config);
        const blocked = await checkDistributedRateLimit('sweep-blocked', config);
        expect(blocked.allowed).toBe(false);

        // Window has elapsed but the block is live — evicting now would reset
        // the counter and void the block.
        expect(sweepExpiredInMemoryAttempts(t0 + 1_000)).toBe(0);
        nowSpy.mockReturnValue(t0 + 1_000);
        const stillBlocked = await checkDistributedRateLimit('sweep-blocked', config);
        expect(stillBlocked.allowed).toBe(false);

        expect(sweepExpiredInMemoryAttempts(t0 + 600_000)).toBe(1);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('caps distinct tracked identifiers, evicting oldest-first under identifier flood', async () => {
      const config: RateLimitConfig = { maxAttempts: 4, windowMs: 60_000 };

      for (let i = 0; i < MAX_IN_MEMORY_ATTEMPT_ENTRIES; i++) {
        await checkDistributedRateLimit(`flood:${i}`, config);
      }

      // A new identifier past the cap is still admitted and enforced (not
      // denied, not unlimited) — the oldest entry is evicted to make room.
      const overCap = await checkDistributedRateLimit('flood:new', config);
      expect(overCap.allowed).toBe(true);

      // flood:0 was evicted, so its counter restarted: conservative threshold
      // is floor(4/2) = 2, and a fresh first attempt reports 1 remaining. Had
      // it survived the flood, this second attempt would report 0.
      const evicted = await checkDistributedRateLimit('flood:0', config);
      expect(evicted.allowed).toBe(true);
      expect(evicted.attemptsRemaining).toBe(1);

      // A recent identifier kept its counter: second attempt → 0 remaining.
      const retained = await checkDistributedRateLimit(`flood:${MAX_IN_MEMORY_ATTEMPT_ENTRIES - 1}`, config);
      expect(retained.allowed).toBe(true);
      expect(retained.attemptsRemaining).toBe(0);
    }, 30_000);
  });

  describe('conservativeFallbackMaxAttempts (pure)', () => {
    it('halves the configured limit, rounding down', () => {
      expect(conservativeFallbackMaxAttempts(5)).toBe(2);
      expect(conservativeFallbackMaxAttempts(100)).toBe(50);
    });

    it('floors at 1 so legitimate users are never denied outright', () => {
      expect(conservativeFallbackMaxAttempts(1)).toBe(1);
      expect(conservativeFallbackMaxAttempts(2)).toBe(1);
      expect(conservativeFallbackMaxAttempts(3)).toBe(1);
    });

    it('never exceeds the configured limit, even at degenerate values', () => {
      expect(conservativeFallbackMaxAttempts(0)).toBe(0);
    });
  });

  describe('conservativeFallbackConfig (pure)', () => {
    it('reduces only maxAttempts, preserving window and block semantics', () => {
      const config: RateLimitConfig = {
        maxAttempts: 10,
        windowMs: 60_000,
        blockDurationMs: 30_000,
        progressiveDelay: true,
      };

      expect(conservativeFallbackConfig(config)).toEqual({
        maxAttempts: 5,
        windowMs: 60_000,
        blockDurationMs: 30_000,
        progressiveDelay: true,
      });
    });
  });

  describe('conservativeFallbackCheck', () => {
    const config: RateLimitConfig = { maxAttempts: 5, windowMs: 60_000 };

    it('enforces the conservative threshold via the injected checker', () => {
      const memCheck = vi.fn().mockReturnValue({ allowed: true, attemptsRemaining: 1 });

      const result = conservativeFallbackCheck('inject-key', config, memCheck);

      expect(memCheck).toHaveBeenCalledWith('inject-key', {
        maxAttempts: 2,
        windowMs: 60_000,
      });
      expect(result.allowed).toBe(true);
    });

    it('fails closed (never open) when the in-memory check itself throws', async () => {
      const { loggers } = await import('../../logging/logger-config');
      const memCheck = vi.fn(() => {
        throw new Error('map corrupted');
      });

      const result = conservativeFallbackCheck('broken-key', config, memCheck);

      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBe(60);
      expect(result.attemptsRemaining).toBe(0);
      expect(loggers.api.error).toHaveBeenCalledWith(
        'Postgres unavailable in production - DENYING request (fail-closed)',
        expect.any(Object)
      );
    });
  });
});

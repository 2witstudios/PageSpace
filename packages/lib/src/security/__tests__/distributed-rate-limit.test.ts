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
  countAuthFailure,
  boundedIdentifier,
  isPgUnavailabilityError,
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

// Same wrapper shape, but with a server-returned SQLSTATE instead of a
// driver-level errno — the server answered, it is not down.
function drizzleWrappedSqlstateError(sqlstate: string, message: string): Error {
  const cause = Object.assign(new Error(message), { code: sqlstate });
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
          const t0 = 10_000_000;
          const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
          try {
            // Exhaust the conservative in-memory threshold during the outage.
            await checkDistributedRateLimit('prod-recovery', testConfig);
            await checkDistributedRateLimit('prod-recovery', testConfig);
            const blocked = await checkDistributedRateLimit('prod-recovery', testConfig);
            expect(blocked.allowed).toBe(false);

            // The probe cooldown elapses and Postgres is healthy again: the
            // distributed count (1) is authoritative — outage-time in-memory
            // counts (already blocked!) must not bleed into the decision.
            nowSpy.mockReturnValue(t0 + 31_000);
            mockInsertReturning(1);
            const recovered = await checkDistributedRateLimit('prod-recovery', testConfig);
            expect(recovered.allowed).toBe(true);
            expect(recovered.attemptsRemaining).toBe(4);
            expect(loggers.api.info).toHaveBeenCalledWith(
              'Distributed rate limiting enabled (Postgres)'
            );

            // The successful probe fully closed the circuit (and released any
            // half-open claim): the next request still goes to Postgres.
            const probes = insertMock.mock.calls.length;
            mockInsertReturning(2);
            const next = await checkDistributedRateLimit('prod-recovery', testConfig);
            expect(next.allowed).toBe(true);
            expect(insertMock.mock.calls.length).toBe(probes + 1);
          } finally {
            nowSpy.mockRestore();
          }
        });

        it('short-circuits Postgres probes while the outage cooldown is active', async () => {
          await checkDistributedRateLimit('breaker-a', testConfig); // probe fails → circuit opens
          const probesAfterOpen = insertMock.mock.calls.length;

          const second = await checkDistributedRateLimit('breaker-a', testConfig);
          const other = await checkDistributedRateLimit('breaker-b', testConfig);

          // No further Postgres work while the circuit is open — the stalled
          // pool must not accumulate probes — yet limits are still enforced.
          expect(insertMock.mock.calls.length).toBe(probesAfterOpen);
          expect(second.allowed).toBe(true);
          expect(other.allowed).toBe(true);
        });

        it('serializes the half-open probe: concurrent requests do not stampede Postgres', async () => {
          const t0 = 10_000_000;
          const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
          try {
            await checkDistributedRateLimit('herd', testConfig); // opens circuit

            nowSpy.mockReturnValue(t0 + 31_000);
            // Async-rejecting insert models the OOM-stalled pool: the probe
            // hangs on its await instead of failing synchronously, so the
            // other concurrent requests arrive while it is still in flight.
            insertMock.mockImplementation(() => ({
              values: () => ({
                onConflictDoUpdate: () => ({
                  returning: () => Promise.reject(drizzleWrappedPgError()),
                }),
              }),
            }));
            const probesBefore = insertMock.mock.calls.length;
            const results = await Promise.all([
              checkDistributedRateLimit('herd', testConfig),
              checkDistributedRateLimit('herd', testConfig),
              checkDistributedRateLimit('herd', testConfig),
            ]);

            // Exactly ONE request performed the half-open probe; the rest were
            // served by the fallback without touching the stalled pool.
            expect(insertMock.mock.calls.length).toBe(probesBefore + 1);
            for (const r of results) {
              expect(typeof r.allowed).toBe('boolean');
            }

            // The failed probe released its claim: after another cooldown the
            // next request probes again rather than deadlocking on the flag.
            nowSpy.mockReturnValue(t0 + 62_000);
            await checkDistributedRateLimit('herd', testConfig);
            expect(insertMock.mock.calls.length).toBe(probesBefore + 2);
          } finally {
            nowSpy.mockRestore();
          }
        });

        it('does not open the circuit for data errors the server actively returned', async () => {
          // A hostile payload (e.g. an oversized OAuth client_id blowing the
          // B-tree entry limit) fails only ITS insert, with a server-returned
          // SQLSTATE. The server is alive — the process-wide circuit must not
          // open, or the payload becomes a lever to degrade every instance to
          // the conservative fallback while Postgres is healthy.
          mockInsertThrows(
            drizzleWrappedSqlstateError('54000', 'index row size exceeds maximum')
          );
          const first = await checkDistributedRateLimit('data-error', testConfig);
          expect(first.allowed).toBe(true); // this request still gets limited via fallback

          const probes = insertMock.mock.calls.length;
          await checkDistributedRateLimit('data-error-b', testConfig);
          expect(insertMock.mock.calls.length).toBe(probes + 1); // still probing Postgres
        });

        it('opens the circuit for connection-class SQLSTATE errors', async () => {
          mockInsertThrows(drizzleWrappedSqlstateError('08006', 'connection failure'));
          await checkDistributedRateLimit('conn-error', testConfig);

          const probes = insertMock.mock.calls.length;
          await checkDistributedRateLimit('conn-error-b', testConfig);
          expect(insertMock.mock.calls.length).toBe(probes); // circuit open, no probe
        });

        it('throttles the fallback WARN to once per interval with a suppression count', async () => {
          const { loggers } = await import('../../logging/logger-config');
          const t0 = 10_000_000;
          const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
          try {
            await checkDistributedRateLimit('warn-a', testConfig);
            await checkDistributedRateLimit('warn-b', testConfig);
            await checkDistributedRateLimit('warn-c', testConfig);
            const markerWarns = vi
              .mocked(loggers.api.warn)
              .mock.calls.filter((c) => String(c[0]).includes('RATE_LIMIT_PG_FALLBACK'));
            expect(markerWarns.length).toBe(1);

            // Next interval: one WARN, carrying how many were suppressed.
            nowSpy.mockReturnValue(t0 + 31_000);
            await checkDistributedRateLimit('warn-d', testConfig);
            const after = vi
              .mocked(loggers.api.warn)
              .mock.calls.filter((c) => String(c[0]).includes('RATE_LIMIT_PG_FALLBACK'));
            expect(after.length).toBe(2);
            expect(after[1][1]).toMatchObject({ suppressedSinceLastWarn: 2 });
          } finally {
            nowSpy.mockRestore();
          }
        });

        it('a stale success from before the circuit opened does not close it', async () => {
          // Two requests are in flight together while the circuit is closed.
          // The failing one opens the circuit; the SLOWER success from the
          // same batch must not clear the fresh cooldown — intermittent
          // stalls produce exactly this interleaving, and a stale success
          // would re-expose Postgres to the full request stream instead of
          // the single half-open probe.
          let resolveSlow!: (rows: { count: number }[]) => void;
          const slowRows = new Promise<{ count: number }[]>((r) => {
            resolveSlow = r;
          });
          insertMock
            .mockImplementationOnce(() => ({
              values: () => ({
                onConflictDoUpdate: () => ({ returning: () => slowRows }),
              }),
            }))
            .mockImplementationOnce(() => {
              throw drizzleWrappedPgError();
            });

          const slowCheck = checkDistributedRateLimit('stale-a', testConfig); // in flight
          const failed = await checkDistributedRateLimit('stale-b', testConfig); // opens circuit
          expect(failed.allowed).toBe(true); // served by the fallback

          resolveSlow([{ count: 1 }]);
          const slow = await slowCheck; // stale success lands after the open
          expect(slow.allowed).toBe(true);

          // The circuit must still be open: the next request short-circuits.
          const probes = insertMock.mock.calls.length;
          await checkDistributedRateLimit('stale-c', testConfig);
          expect(insertMock.mock.calls.length).toBe(probes);
        });

        it('re-probes once after the cooldown and re-opens on continued failure', async () => {
          const t0 = 10_000_000;
          const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
          try {
            await checkDistributedRateLimit('breaker-reopen', testConfig); // opens circuit
            const callsWhileOpen = insertMock.mock.calls.length;

            nowSpy.mockReturnValue(t0 + 31_000);
            await checkDistributedRateLimit('breaker-reopen', testConfig); // half-open probe fails
            expect(insertMock.mock.calls.length).toBe(callsWhileOpen + 1);

            await checkDistributedRateLimit('breaker-reopen', testConfig); // circuit re-opened
            expect(insertMock.mock.calls.length).toBe(callsWhileOpen + 1);
          } finally {
            nowSpy.mockRestore();
          }
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

    it('attempts the Postgres delete even while the outage cooldown is active', async () => {
      // Resets REFUND a consumed limit (e.g. EXPORT_DATA's 1-per-24h after a
      // failed export). Skipping the delete while the circuit is open would
      // leave the Postgres row intact and 429 the caller for the rest of the
      // window once Postgres recovers. Resets are low-volume, so they are
      // deliberately not breaker-gated.
      process.env.NODE_ENV = 'production';
      mockInsertThrows(drizzleWrappedPgError());
      const config: RateLimitConfig = { maxAttempts: 5, windowMs: 60_000 };
      await checkDistributedRateLimit('reset-breaker', config); // opens circuit

      deleteMock.mockClear();
      mockDeleteResolves();
      await resetDistributedRateLimit('reset-breaker');
      expect(deleteMock).toHaveBeenCalled();

      // The in-memory side was also cleared: next fallback check starts a
      // fresh conservative window (first of 2 → 1 remaining).
      const after = await checkDistributedRateLimit('reset-breaker', config);
      expect(after.attemptsRemaining).toBe(1);
    });

    it('a successful reset delete closes the circuit as evidence of recovery', async () => {
      process.env.NODE_ENV = 'production';
      mockInsertThrows(drizzleWrappedPgError());
      const config: RateLimitConfig = { maxAttempts: 5, windowMs: 60_000 };
      await checkDistributedRateLimit('reset-recovery', config); // opens circuit

      mockDeleteResolves();
      await resetDistributedRateLimit('reset-recovery'); // delete succeeds → PG is back

      mockInsertReturning(1);
      const next = await checkDistributedRateLimit('reset-recovery-2', config);
      expect(next.allowed).toBe(true);
      expect(next.attemptsRemaining).toBe(4); // distributed path, not fallback
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

    it('short-circuits status probes while the outage cooldown is active', async () => {
      process.env.NODE_ENV = 'production';
      mockInsertThrows(drizzleWrappedPgError());
      await checkDistributedRateLimit('status-breaker', testConfig); // opens circuit

      selectMock.mockClear();
      const status = await getDistributedRateLimitStatus('status-breaker', testConfig);
      expect(selectMock).not.toHaveBeenCalled();
      // 1 of the conservative 2 attempts consumed during the outage.
      expect(status.blocked).toBe(false);
      expect(status.attemptsRemaining).toBe(1);
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

  describe('countAuthFailure under outage cooldown', () => {
    it('returns 0 without probing Postgres while the cooldown is active', async () => {
      process.env.NODE_ENV = 'production';
      mockInsertThrows(drizzleWrappedPgError());
      await checkDistributedRateLimit('authfail-breaker', {
        maxAttempts: 5,
        windowMs: 60_000,
      }); // opens circuit

      const probes = insertMock.mock.calls.length;
      const count = await countAuthFailure('user@example.com', 60_000);
      expect(count).toBe(0);
      expect(insertMock.mock.calls.length).toBe(probes);
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

    it('does not evict an actively blocked entry to admit new identifiers', async () => {
      // maxAttempts 2 → conservative threshold 1; second check trips the block.
      // blockDurationMs equals windowMs deliberately: this is the
      // FORM_SUBMISSION shape, where a blocked entry does NOT outlive newer
      // window entries — eviction policies that merely prefer later-expiring
      // entries still sacrifice this block.
      const config: RateLimitConfig = {
        maxAttempts: 2,
        windowMs: 60_000,
        blockDurationMs: 60_000,
      };
      await checkDistributedRateLimit('evict-victim', config);
      const blocked = await checkDistributedRateLimit('evict-victim', config);
      expect(blocked.allowed).toBe(false);

      // The blocked entry is the oldest in the map. Flooding past the cap must
      // not evict it — otherwise an attacker could flush their own block by
      // spraying fresh identifiers.
      for (let i = 0; i < MAX_IN_MEMORY_ATTEMPT_ENTRIES; i++) {
        await checkDistributedRateLimit(`evict-flood:${i}`, config);
      }

      const still = await checkDistributedRateLimit('evict-victim', config);
      expect(still.allowed).toBe(false);
    }, 30_000);

    it('denies everything when configured maxAttempts is 0, even in the fallback', async () => {
      // PG-up semantics for maxAttempts 0 are "always deny" (count 1 > 0); the
      // fallback must never be looser than the configured limit.
      const config: RateLimitConfig = { maxAttempts: 0, windowMs: 60_000 };
      const result = await checkDistributedRateLimit('zero-config', config);
      expect(result.allowed).toBe(false);
    });

    it('re-arms the cleanup sweep when traffic resumes after shutdown', async () => {
      vi.useFakeTimers();
      try {
        shutdownRateLimiting();
        await checkDistributedRateLimit('rearm', { maxAttempts: 5, windowMs: 50 });
        // One interval tick later the expired entry must already be gone —
        // i.e. the insert re-armed the sweep the shutdown had cleared.
        vi.advanceTimersByTime(5 * 60 * 1000 + 1);
        expect(sweepExpiredInMemoryAttempts(Date.now())).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('characterizes bounded overage across a flapping outage (accepted trade-off)', async () => {
      // Distributed and in-memory counters are disjoint by design: warming the
      // in-memory map on every successful PG check would churn the capped store
      // for all traffic. Worst case when PG flaps mid-window is configured +
      // conservative threshold (~1.5x) per instance — bounded, and strictly
      // tighter than the pre-fallback alternative of an unbounded bypass.
      const config: RateLimitConfig = { maxAttempts: 5, windowMs: 60_000 };
      mockInsertReturning(5);
      const atLimit = await checkDistributedRateLimit('flap', config);
      expect(atLimit.allowed).toBe(true);

      mockInsertThrows(drizzleWrappedPgError());
      const r1 = await checkDistributedRateLimit('flap', config);
      const r2 = await checkDistributedRateLimit('flap', config);
      const r3 = await checkDistributedRateLimit('flap', config);
      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
      expect(r3.allowed).toBe(false);
    });

    it('denies previously unseen identifiers at capacity instead of evicting active counters', async () => {
      const config: RateLimitConfig = { maxAttempts: 4, windowMs: 60_000 };

      for (let i = 0; i < MAX_IN_MEMORY_ATTEMPT_ENTRIES; i++) {
        await checkDistributedRateLimit(`flood:${i}`, config);
      }

      // Every tracked window is still active, so there is no safe slot: the
      // unseen identifier is conservatively denied rather than resetting
      // someone else's active limit (never fail open, never sacrifice a
      // victim's counter to an identifier-rotation flood).
      const overCap = await checkDistributedRateLimit('flood:new', config);
      expect(overCap.allowed).toBe(false);
      expect(overCap.retryAfter).toBeGreaterThan(0);

      // Existing counters were preserved: flood:0 is on its second attempt of
      // the conservative threshold floor(4/2) = 2 → 0 remaining, not a fresh
      // window.
      const oldest = await checkDistributedRateLimit('flood:0', config);
      expect(oldest.allowed).toBe(true);
      expect(oldest.attemptsRemaining).toBe(0);
    }, 30_000);

    it('reclaims expired entries at capacity instead of denying new identifiers', async () => {
      const t0 = 10_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
      try {
        const config: RateLimitConfig = { maxAttempts: 4, windowMs: 60_000 };
        for (let i = 0; i < MAX_IN_MEMORY_ATTEMPT_ENTRIES; i++) {
          await checkDistributedRateLimit(`stale:${i}`, config);
        }

        // Every tracked window has elapsed: capacity is reclaimable, so a new
        // identifier must be admitted, not denied.
        nowSpy.mockReturnValue(t0 + 61_000);
        const fresh = await checkDistributedRateLimit('stale:new', config);
        expect(fresh.allowed).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }
    }, 30_000);

    it('reclaims expired capacity beyond the bounded scan via a throttled full sweep', async () => {
      const t0 = 10_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);
      try {
        const longConfig: RateLimitConfig = { maxAttempts: 4, windowMs: 3_600_000 };
        const shortConfig: RateLimitConfig = { maxAttempts: 4, windowMs: 60_000 };

        // The oldest entries are long-lived and still active; everything
        // behind them is expired but out of reach of the bounded scan.
        for (let i = 0; i < 20; i++) {
          await checkDistributedRateLimit(`long:${i}`, longConfig);
        }
        for (let i = 0; i < MAX_IN_MEMORY_ATTEMPT_ENTRIES - 20; i++) {
          await checkDistributedRateLimit(`short:${i}`, shortConfig);
        }

        nowSpy.mockReturnValue(t0 + 61_000);
        const fresh = await checkDistributedRateLimit('short:new', shortConfig);
        expect(fresh.allowed).toBe(true);

        // The long-lived active counters survived reclamation: second attempt
        // on an existing window → 0 of the conservative 2 remaining.
        const long0 = await checkDistributedRateLimit('long:0', longConfig);
        expect(long0.allowed).toBe(true);
        expect(long0.attemptsRemaining).toBe(0);
      } finally {
        nowSpy.mockRestore();
      }
    }, 30_000);

    it('bounds oversized identifiers by hashing before storing them as map keys', async () => {
      // Unbounded attacker-supplied identifiers (e.g. 10KB OAuth client_ids)
      // would defeat the entry cap's memory bound. Keys longer than the bound
      // are hashed — not truncated — so distinct identifiers stay distinct.
      const config: RateLimitConfig = { maxAttempts: 4, windowMs: 60_000 };
      const longId = 'x'.repeat(10_000) + 'suffix-a';

      const first = await checkDistributedRateLimit(longId, config);
      expect(first.attemptsRemaining).toBe(1);

      // The stored key IS the bounded form: presenting the bounded form
      // directly shares the oversized original's counter.
      const { createHash } = await import('crypto');
      const boundedForm = `h:${createHash('sha256').update(longId).digest('hex')}`;
      const second = await checkDistributedRateLimit(boundedForm, config);
      expect(second.attemptsRemaining).toBe(0);

      // A different oversized identifier with the same prefix keeps its own
      // counter (would collide under truncation).
      const otherLong = 'x'.repeat(10_000) + 'suffix-b';
      const fresh = await checkDistributedRateLimit(otherLong, config);
      expect(fresh.attemptsRemaining).toBe(1);
    });
  });

  describe('boundedIdentifier (pure)', () => {
    it('returns identifiers within the bound unchanged', () => {
      expect(boundedIdentifier('login:203.0.113.7')).toBe('login:203.0.113.7');
      expect(boundedIdentifier('x'.repeat(128))).toBe('x'.repeat(128));
    });

    it('hashes oversized identifiers to fixed-length, distinct, stable keys', () => {
      const a = boundedIdentifier('x'.repeat(200) + 'a');
      const b = boundedIdentifier('x'.repeat(200) + 'b');
      expect(a).not.toBe(b);
      expect(a.length).toBeLessThanOrEqual(80);
      expect(boundedIdentifier('x'.repeat(200) + 'a')).toBe(a);
    });
  });

  describe('isPgUnavailabilityError (pure)', () => {
    it('treats driver-level network errors and connection/resource/shutdown SQLSTATEs as outages', () => {
      expect(isPgUnavailabilityError(drizzleWrappedPgError())).toBe(true); // ECONNREFUSED
      expect(isPgUnavailabilityError(drizzleWrappedSqlstateError('08006', 'connection failure'))).toBe(true);
      expect(isPgUnavailabilityError(drizzleWrappedSqlstateError('53300', 'too many connections'))).toBe(true);
      expect(isPgUnavailabilityError(drizzleWrappedSqlstateError('57P01', 'terminating connection'))).toBe(true);
      expect(isPgUnavailabilityError(new Error('socket hang up'))).toBe(true); // no code at all
    });

    it('treats server-returned data/logic errors as NOT outages', () => {
      expect(isPgUnavailabilityError(drizzleWrappedSqlstateError('54000', 'index row size exceeds maximum'))).toBe(false);
      expect(isPgUnavailabilityError(drizzleWrappedSqlstateError('22001', 'value too long'))).toBe(false);
      expect(isPgUnavailabilityError(drizzleWrappedSqlstateError('42P01', 'relation does not exist'))).toBe(false);
    });
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

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLoggerWarn, mockLogPerformance, mockGetAdvisoryLockPool } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
  mockLogPerformance: vi.fn(),
  mockGetAdvisoryLockPool: vi.fn(),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() } },
  logPerformance: mockLogPerformance,
}));

vi.mock('@pagespace/db/db', () => ({ getAdvisoryLockPool: mockGetAdvisoryLockPool }));

import {
  decideOnLockBusy,
  startGenerationExclusive,
  MAX_LOCK_BUSY_RETRIES,
  LOCK_BUSY_RETRY_DELAY_MS,
} from '../start-generation-exclusive';
import type { AdvisoryLockClient, AdvisoryLockPool } from '@pagespace/db/advisory-lock';

function makeClient(acquiredSequence: boolean[]) {
  const query = vi.fn();
  for (const acquired of acquiredSequence) {
    query.mockResolvedValueOnce({ rows: [{ acquired }] }); // try-lock
    if (acquired) query.mockResolvedValueOnce({ rows: [] }); // unlock
  }
  return { query, release: vi.fn() } satisfies AdvisoryLockClient;
}

function makePool(client: AdvisoryLockClient): AdvisoryLockPool {
  return { connect: vi.fn(async () => client) };
}

beforeEach(() => {
  mockLoggerWarn.mockReset();
  mockLogPerformance.mockReset();
  mockGetAdvisoryLockPool.mockReset();
});

describe('decideOnLockBusy (pure)', () => {
  it('given fewer busy attempts than the retry budget, should retry after the fixed delay', () => {
    for (let attemptsMade = 1; attemptsMade <= MAX_LOCK_BUSY_RETRIES; attemptsMade++) {
      expect(decideOnLockBusy({ attemptsMade })).toEqual({ action: 'retry', delayMs: LOCK_BUSY_RETRY_DELAY_MS });
    }
  });

  it('given the retry budget is exhausted, should proceed unlocked', () => {
    expect(decideOnLockBusy({ attemptsMade: MAX_LOCK_BUSY_RETRIES + 1 })).toEqual({ action: 'proceed_unlocked' });
  });
});

describe('startGenerationExclusive', () => {
  it('given the lock is free on the first try, should acquire it, run inside the lock, and report outcome "locked"', async () => {
    const client = makeClient([true]);
    const pool = makePool(client);
    const run = vi.fn(async () => 'lifecycle-handle');
    const sleep = vi.fn(async () => {});

    const result = await startGenerationExclusive({ conversationId: 'conv-1', run, pool, sleep });

    expect(result).toEqual({ outcome: 'locked', result: 'lifecycle-handle' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockLogPerformance).not.toHaveBeenCalled();
  });

  it('given the lock is busy then frees up within the retry budget, should retry with the fixed backoff and still run inside the lock', async () => {
    const client = makeClient([false, false, true]);
    const pool = makePool(client);
    const run = vi.fn(async () => 'lifecycle-handle');
    const sleep = vi.fn(async () => {});

    const result = await startGenerationExclusive({ conversationId: 'conv-1', run, pool, sleep });

    expect(result).toEqual({ outcome: 'locked', result: 'lifecycle-handle' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, LOCK_BUSY_RETRY_DELAY_MS);
    expect(sleep).toHaveBeenNthCalledWith(2, LOCK_BUSY_RETRY_DELAY_MS);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockLogPerformance).not.toHaveBeenCalled();
  });

  it('given the lock stays busy through the full retry budget, should retry exactly 3 times at 300ms then proceed unlocked, running fn exactly once outside the lock', async () => {
    const client = makeClient([false, false, false, false]);
    const pool = makePool(client);
    const run = vi.fn(async () => 'lifecycle-handle');
    const sleep = vi.fn(async () => {});

    const result = await startGenerationExclusive({ conversationId: 'conv-1', run, pool, sleep });

    expect(result).toEqual({ outcome: 'degraded', result: 'lifecycle-handle' });
    // fn is never passed to (and never invoked by) withAdvisoryLock on a lock_busy outcome —
    // it only runs once, directly, for the unlocked fallback.
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(MAX_LOCK_BUSY_RETRIES);
    expect(sleep).toHaveBeenCalledWith(LOCK_BUSY_RETRY_DELAY_MS);
  });

  it('given it degrades to unlocked, should name the guarantee "best-effort"/"degraded" in a structured warn AND emit a named metric — never silently', async () => {
    const client = makeClient([false, false, false, false]);
    const pool = makePool(client);
    const run = vi.fn(async () => 'lifecycle-handle');
    const sleep = vi.fn(async () => {});

    await startGenerationExclusive({ conversationId: 'conv-42', run, pool, sleep });

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    const [warnMessage, warnMeta] = mockLoggerWarn.mock.calls[0];
    expect(String(warnMessage).toLowerCase()).toMatch(/degrad|unlocked|best-effort/);
    expect(warnMeta).toMatchObject({ conversationId: 'conv-42' });

    expect(mockLogPerformance).toHaveBeenCalledTimes(1);
    const [metricName, metricValue, metricUnit, metricMeta] = mockLogPerformance.mock.calls[0];
    expect(metricName).toEqual(expect.stringContaining('advisory_lock'));
    expect(metricValue).toBe(1);
    expect(metricUnit).toBe('count');
    expect(metricMeta).toMatchObject({ conversationId: 'conv-42' });
  });

  it('given the lock is acquired, should never emit degraded telemetry', async () => {
    const client = makeClient([true]);
    const pool = makePool(client);
    const run = vi.fn(async () => 'lifecycle-handle');

    await startGenerationExclusive({ conversationId: 'conv-1', run, pool, sleep: vi.fn(async () => {}) });

    expect(mockLoggerWarn).not.toHaveBeenCalled();
    expect(mockLogPerformance).not.toHaveBeenCalled();
  });

  it('should scope the advisory lock key to the conversation, distinguishing it from other lock consumers', async () => {
    const client = makeClient([true]);
    const pool = makePool(client);
    const run = vi.fn(async () => 'lifecycle-handle');

    await startGenerationExclusive({ conversationId: 'conv-distinctive-123', run, pool, sleep: vi.fn(async () => {}) });

    const tryLockCall = client.query.mock.calls[0];
    expect(tryLockCall[1]).toEqual(['ai-send:conv-distinctive-123']);
  });

  it('given no pool override, should default to the dedicated advisory-lock pool (getAdvisoryLockPool)', async () => {
    const client = makeClient([true]);
    const pool = makePool(client);
    mockGetAdvisoryLockPool.mockReturnValue(pool);
    const run = vi.fn(async () => 'lifecycle-handle');

    const result = await startGenerationExclusive({ conversationId: 'conv-1', run, sleep: vi.fn(async () => {}) });

    expect(mockGetAdvisoryLockPool).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ outcome: 'locked', result: 'lifecycle-handle' });
  });

  it('given no sleep override, should back off with a real timer-based delay between retries', async () => {
    vi.useFakeTimers();
    try {
      const client = makeClient([false, true]);
      const pool = makePool(client);
      const run = vi.fn(async () => 'lifecycle-handle');

      const pending = startGenerationExclusive({ conversationId: 'conv-1', run, pool });
      await vi.advanceTimersByTimeAsync(LOCK_BUSY_RETRY_DELAY_MS);
      const result = await pending;

      expect(result).toEqual({ outcome: 'locked', result: 'lifecycle-handle' });
    } finally {
      vi.useRealTimers();
    }
  });

  describe('lock machinery failure (pool.connect()/try-lock query throws — NOT a resolved lock_busy)', () => {
    it('given pool.connect() rejects, should proceed unlocked (never propagate) and run fn exactly once', async () => {
      const pool: AdvisoryLockPool = { connect: vi.fn(async () => { throw new Error('connection refused'); }) };
      const run = vi.fn(async () => 'lifecycle-handle');
      const sleep = vi.fn(async () => {});

      const result = await startGenerationExclusive({ conversationId: 'conv-1', run, pool, sleep });

      expect(result).toEqual({ outcome: 'degraded', result: 'lifecycle-handle' });
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('given the try-lock query itself throws (poisoned connection), should proceed unlocked (never propagate) and run fn exactly once', async () => {
      const client = { query: vi.fn().mockRejectedValueOnce(new Error('connection reset')), release: vi.fn() } satisfies AdvisoryLockClient;
      const pool = makePool(client);
      const run = vi.fn(async () => 'lifecycle-handle');
      const sleep = vi.fn(async () => {});

      const result = await startGenerationExclusive({ conversationId: 'conv-1', run, pool, sleep });

      expect(result).toEqual({ outcome: 'degraded', result: 'lifecycle-handle' });
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('given the lock machinery fails, should NOT retry/sleep (unlike lock_busy) — it degrades immediately', async () => {
      const pool: AdvisoryLockPool = { connect: vi.fn(async () => { throw new Error('pool exhausted'); }) };
      const run = vi.fn(async () => 'lifecycle-handle');
      const sleep = vi.fn(async () => {});

      await startGenerationExclusive({ conversationId: 'conv-1', run, pool, sleep });

      expect(sleep).not.toHaveBeenCalled();
    });

    it('given the lock machinery fails, should emit telemetry naming it distinctly from a lock_busy degrade — never silently', async () => {
      const pool: AdvisoryLockPool = { connect: vi.fn(async () => { throw new Error('pool exhausted'); }) };
      const run = vi.fn(async () => 'lifecycle-handle');
      const sleep = vi.fn(async () => {});

      await startGenerationExclusive({ conversationId: 'conv-77', run, pool, sleep });

      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      const [warnMessage, warnMeta] = mockLoggerWarn.mock.calls[0];
      expect(String(warnMessage).toLowerCase()).toMatch(/degrad|unlocked|best-effort/);
      expect(warnMeta).toMatchObject({ conversationId: 'conv-77', reason: 'lock_error', error: 'pool exhausted' });

      expect(mockLogPerformance).toHaveBeenCalledTimes(1);
      const [metricName, metricValue, metricUnit, metricMeta] = mockLogPerformance.mock.calls[0];
      expect(metricName).toEqual(expect.stringContaining('advisory_lock'));
      expect(metricValue).toBe(1);
      expect(metricUnit).toBe('count');
      expect(metricMeta).toEqual({ conversationId: 'conv-77', attemptsMade: 0, reason: 'lock_error' });
    });

    it('given the lock machinery throws a non-Error value, should still stringify it in the warn metadata', async () => {
      const pool: AdvisoryLockPool = { connect: vi.fn(async () => { throw 'connection reset'; }) };
      const run = vi.fn(async () => 'lifecycle-handle');
      const sleep = vi.fn(async () => {});

      await startGenerationExclusive({ conversationId: 'conv-1', run, pool, sleep });

      const [, warnMeta] = mockLoggerWarn.mock.calls[0];
      expect(warnMeta).toMatchObject({ error: 'connection reset' });
    });

    it('given the lock-busy degrade path, telemetry should carry reason "lock_busy" (distinguishable from lock_error)', async () => {
      const client = makeClient([false, false, false, false]);
      const pool = makePool(client);
      const run = vi.fn(async () => 'lifecycle-handle');
      const sleep = vi.fn(async () => {});

      await startGenerationExclusive({ conversationId: 'conv-1', run, pool, sleep });

      const [, warnMeta] = mockLoggerWarn.mock.calls[0];
      expect(warnMeta).toMatchObject({ reason: 'lock_busy' });
      const [, , , metricMeta] = mockLogPerformance.mock.calls[0];
      expect(metricMeta).toMatchObject({ reason: 'lock_busy' });
    });
  });

  describe('run() throws while the lock is genuinely acquired (NOT a lock-machinery failure)', () => {
    it('given the lock is genuinely acquired and run() throws, should propagate the error and NOT invoke run a second time unlocked (no double generation)', async () => {
      const client = makeClient([true]);
      const pool = makePool(client);
      const runError = new Error('placeholder insert failed');
      // Mirrors the reviewer's repro exactly: run rejects on its first (locked) invocation
      // only. Pre-fix, the outer catch misclassified this as lock machinery failure and
      // called degradeToUnlocked(..., run), invoking run a second time — unlocked — which
      // would resolve here with 'second-call-result' and outcome 'degraded'.
      const run = vi.fn().mockRejectedValueOnce(runError).mockResolvedValueOnce('second-call-result');
      const sleep = vi.fn(async () => {});

      await expect(startGenerationExclusive({ conversationId: 'conv-1', run, pool, sleep })).rejects.toThrow(runError);

      expect(run).toHaveBeenCalledTimes(1);
    });

    it('given run() throws with the lock held, should NOT emit lock-degrade telemetry (this is a run failure, not a lock failure)', async () => {
      const client = makeClient([true]);
      const pool = makePool(client);
      const run = vi.fn(async () => { throw new Error('boom'); });
      const sleep = vi.fn(async () => {});

      await expect(startGenerationExclusive({ conversationId: 'conv-1', run, pool, sleep })).rejects.toThrow('boom');

      expect(mockLoggerWarn).not.toHaveBeenCalled();
      expect(mockLogPerformance).not.toHaveBeenCalled();
    });

    it('given run() throws with the lock held, the advisory lock must still be released (finally-in-withAdvisoryLock, unaffected by the fix)', async () => {
      const client = makeClient([true]);
      const pool = makePool(client);
      const run = vi.fn(async () => { throw new Error('boom'); });

      await expect(
        startGenerationExclusive({ conversationId: 'conv-1', run, pool, sleep: vi.fn(async () => {}) }),
      ).rejects.toThrow('boom');

      // The lock was genuinely acquired despite run() throwing, and its release contract
      // (client.release, not the raw query count) must still be honored.
      expect(client.release).toHaveBeenCalledTimes(1);
    });

    it('given run() SUCCEEDS but withAdvisoryLock\'s post-run unlock AND destroy both throw, should still resolve locked with run\'s result and NOT invoke run a second time unlocked', async () => {
      // Codex review finding on PR #2080, contract updated by PR #2097: withAdvisoryLock's
      // release machinery (`unlockAndRelease`/`releaseQuietly` in
      // packages/db/src/advisory-lock.ts) now NEVER throws — a failed unlock destroys the
      // connection, and a destroy that itself throws is swallowed and logged. So even this
      // double failure (unlock query rejects, then `client.release(err)` throws too) can no
      // longer escape the finally and override `run`'s already-successful return. The
      // property this test has always guarded is unchanged: `run` executes exactly once and
      // is never re-invoked unlocked — but now the caller also keeps the successful result
      // instead of losing an already-started generation to lock-cleanup noise.
      const releaseError = new Error('release also failed');
      const client: AdvisoryLockClient = {
        query: vi
          .fn()
          .mockResolvedValueOnce({ rows: [{ acquired: true }] }) // try-lock: acquired
          .mockRejectedValueOnce(new Error('unlock query failed')), // unlock: fails
        release: vi.fn((err?: Error) => {
          if (err) throw releaseError; // the destroy-on-release fallback also throws
        }),
      };
      const pool = makePool(client);
      const run = vi.fn(async () => 'lifecycle-handle');
      const sleep = vi.fn(async () => {});

      const result = await startGenerationExclusive({ conversationId: 'conv-1', run, pool, sleep });

      expect(result).toEqual({ outcome: 'locked', result: 'lifecycle-handle' });
      expect(run).toHaveBeenCalledTimes(1);
      // The destroy WAS attempted (release(err)) — the failure is contained, not skipped.
      expect(client.release).toHaveBeenCalledWith(expect.any(Error));
      // Not a lock_error: no degrade telemetry for a post-run cleanup failure.
      expect(mockLogPerformance).not.toHaveBeenCalled();
    });

    it('given a prior call on the SAME conversation had run() throw, a later call that hits a genuine lock-machinery failure should still degrade normally', async () => {
      // `runThrew` is local to each startGenerationExclusive invocation (a fresh closure per
      // call), so nothing from a prior call's rejection can leak into the next one — this
      // exercises that with the same conversationId, not just structural reasoning about it.
      const firstCallClient = makeClient([true]);
      const firstCallPool = makePool(firstCallClient);
      await expect(
        startGenerationExclusive({
          conversationId: 'conv-1',
          run: vi.fn(async () => { throw new Error('first call run failure'); }),
          pool: firstCallPool,
          sleep: vi.fn(async () => {}),
        }),
      ).rejects.toThrow('first call run failure');

      const run = vi.fn(async () => 'lifecycle-handle');
      const brokenPool: AdvisoryLockPool = { connect: vi.fn(async () => { throw new Error('pool exhausted'); }) };
      const result = await startGenerationExclusive({ conversationId: 'conv-1', run, pool: brokenPool, sleep: vi.fn(async () => {}) });

      expect(result).toEqual({ outcome: 'degraded', result: 'lifecycle-handle' });
      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});

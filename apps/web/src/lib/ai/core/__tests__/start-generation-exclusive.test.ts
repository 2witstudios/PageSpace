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
      expect(warnMeta).toMatchObject({ conversationId: 'conv-77', reason: 'lock_error' });

      expect(mockLogPerformance).toHaveBeenCalledTimes(1);
      const [metricName, metricValue, metricUnit, metricMeta] = mockLogPerformance.mock.calls[0];
      expect(metricName).toEqual(expect.stringContaining('advisory_lock'));
      expect(metricValue).toBe(1);
      expect(metricUnit).toBe('count');
      expect(metricMeta).toMatchObject({ conversationId: 'conv-77', reason: 'lock_error' });
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
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createClickHouseBuffer,
  DEFAULT_MAX_ROWS,
  DEFAULT_FLUSH_INTERVAL_MS,
} from '../clickhouse-buffer';

interface TestRow {
  id: number;
  secret: string;
}

const row = (id: number): TestRow => ({ id, secret: `pii-payload-${id}` });

describe('createClickHouseBuffer — buffer contract (#890 Phase 3 design ref)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('pure factory', () => {
    it('given two buffers for different tables, should keep fully independent state (no module-level state)', async () => {
      const insertA = vi.fn().mockResolvedValue(undefined);
      const insertB = vi.fn().mockResolvedValue(undefined);
      const a = createClickHouseBuffer<TestRow>('api_metrics', { insert: insertA });
      const b = createClickHouseBuffer<TestRow>('system_logs', { insert: insertB });

      a.insert(row(1));
      await a.flush();

      expect(insertA).toHaveBeenCalledTimes(1);
      expect(insertB).not.toHaveBeenCalled();
      expect(b.pendingCount()).toBe(0);
    });

    it('given the factory is created, should not schedule timers or touch the client until the first insert', () => {
      const insert = vi.fn().mockResolvedValue(undefined);
      createClickHouseBuffer<TestRow>('api_metrics', { insert });

      vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS * 5);

      expect(insert).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('accumulation below threshold', () => {
    it('given fewer rows than the threshold and no timer tick, should accumulate without flushing', () => {
      const insert = vi.fn().mockResolvedValue(undefined);
      const buffer = createClickHouseBuffer<TestRow>('api_metrics', { insert });

      for (let i = 0; i < DEFAULT_MAX_ROWS - 1; i++) buffer.insert(row(i));

      expect(insert).not.toHaveBeenCalled();
      expect(buffer.pendingCount()).toBe(DEFAULT_MAX_ROWS - 1);
    });
  });

  describe('flush at row threshold', () => {
    it('given the 500th row (default), should auto-flush the whole batch to the injected insert', () => {
      const insert = vi.fn().mockResolvedValue(undefined);
      const buffer = createClickHouseBuffer<TestRow>('api_metrics', { insert });

      for (let i = 0; i < DEFAULT_MAX_ROWS; i++) buffer.insert(row(i));

      expect(insert).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledWith({
        table: 'api_metrics',
        values: expect.arrayContaining([row(0), row(DEFAULT_MAX_ROWS - 1)]) as TestRow[],
      });
      const call = insert.mock.calls[0][0] as { values: TestRow[] };
      expect(call.values).toHaveLength(DEFAULT_MAX_ROWS);
      expect(buffer.pendingCount()).toBe(0);
    });

    it('given a custom maxRows, should flush at that threshold instead', () => {
      const insert = vi.fn().mockResolvedValue(undefined);
      const buffer = createClickHouseBuffer<TestRow>('api_metrics', { insert, maxRows: 3 });

      buffer.insert(row(1));
      buffer.insert(row(2));
      expect(insert).not.toHaveBeenCalled();
      buffer.insert(row(3));

      expect(insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('flush on timer tick', () => {
    it('given a pending row and 1000ms elapsed (default), should flush via the timer', () => {
      const insert = vi.fn().mockResolvedValue(undefined);
      const buffer = createClickHouseBuffer<TestRow>('api_metrics', { insert });

      buffer.insert(row(1));
      expect(insert).not.toHaveBeenCalled();

      vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);

      expect(insert).toHaveBeenCalledTimes(1);
      expect(insert).toHaveBeenCalledWith({ table: 'api_metrics', values: [row(1)] });
      expect(buffer.pendingCount()).toBe(0);
    });

    it('given a custom flushIntervalMs, should flush on that interval instead', () => {
      const insert = vi.fn().mockResolvedValue(undefined);
      const buffer = createClickHouseBuffer<TestRow>('api_metrics', {
        insert,
        flushIntervalMs: 250,
      });

      buffer.insert(row(1));
      vi.advanceTimersByTime(249);
      expect(insert).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(insert).toHaveBeenCalledTimes(1);
    });

    it('given a threshold flush already happened, should not double-flush on the stale timer', () => {
      const insert = vi.fn().mockResolvedValue(undefined);
      const buffer = createClickHouseBuffer<TestRow>('api_metrics', { insert, maxRows: 2 });

      buffer.insert(row(1));
      buffer.insert(row(2)); // threshold flush
      expect(insert).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS * 2);
      expect(insert).toHaveBeenCalledTimes(1); // no empty second flush
    });
  });

  describe('never throw / never block the request path', () => {
    it('given the client insert rejects, flush() should resolve without throwing and discard the batch', async () => {
      const insert = vi.fn().mockRejectedValue(new Error('CH down'));
      const buffer = createClickHouseBuffer<TestRow>('api_metrics', {
        insert,
        logError: vi.fn(),
      });

      buffer.insert(row(1));
      await expect(buffer.flush()).resolves.toBeUndefined();
      expect(buffer.pendingCount()).toBe(0); // discarded, not retried
    });

    it('given the client insert throws synchronously, insert()/flush() should still never throw', async () => {
      const insert = vi.fn().mockImplementation(() => {
        throw new Error('sync explosion');
      });
      const buffer = createClickHouseBuffer<TestRow>('api_metrics', {
        insert,
        maxRows: 1,
        logError: vi.fn(),
      });

      expect(() => buffer.insert(row(1))).not.toThrow();
      buffer.insert(row(2));
      await expect(buffer.flush()).resolves.toBeUndefined();
    });

    it('given a timer-tick flush failure, should not produce an unhandled rejection', async () => {
      const insert = vi.fn().mockRejectedValue(new Error('CH down'));
      const buffer = createClickHouseBuffer<TestRow>('api_metrics', {
        insert,
        logError: vi.fn(),
      });

      buffer.insert(row(1));
      vi.advanceTimersByTime(DEFAULT_FLUSH_INTERVAL_MS);
      await vi.runAllTimersAsync();

      expect(insert).toHaveBeenCalledTimes(1);
    });

    it('given a flush in progress, a concurrent insert() should return synchronously and land in the next batch (double-buffer)', async () => {
      let resolveFirst: (() => void) | undefined;
      const insert = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValue(undefined);
      const buffer = createClickHouseBuffer<TestRow>('api_metrics', { insert });

      buffer.insert(row(1));
      const firstFlush = buffer.flush(); // in-flight, unresolved

      buffer.insert(row(2)); // must not block or be swallowed by the in-flight batch
      expect(buffer.pendingCount()).toBe(1);

      resolveFirst?.();
      await firstFlush;
      await buffer.flush();

      expect(insert).toHaveBeenCalledTimes(2);
      expect(insert).toHaveBeenNthCalledWith(1, { table: 'api_metrics', values: [row(1)] });
      expect(insert).toHaveBeenNthCalledWith(2, { table: 'api_metrics', values: [row(2)] });
    });
  });

  describe('flush error logging — table name, NEVER row payloads (PII)', () => {
    it('given a flush failure, should log the table name and error message', async () => {
      const logError = vi.fn();
      const insert = vi.fn().mockRejectedValue(new Error('code 516: auth failed'));
      const buffer = createClickHouseBuffer<TestRow>('user_activities', { insert, logError });

      buffer.insert(row(1));
      await buffer.flush();

      expect(logError).toHaveBeenCalledTimes(1);
      const message = logError.mock.calls[0][0] as string;
      expect(message).toContain('user_activities');
      expect(message).toContain('code 516: auth failed');
    });

    it('given a flush failure, the log line must NOT contain any row payload', async () => {
      const logError = vi.fn();
      const insert = vi.fn().mockRejectedValue(new Error('CH down'));
      const buffer = createClickHouseBuffer<TestRow>('user_activities', { insert, logError });

      buffer.insert(row(42));
      await buffer.flush();

      const message = logError.mock.calls[0][0] as string;
      expect(message).not.toContain('pii-payload-42');
      expect(message).not.toContain('"id"');
      expect(message).not.toContain('42');
    });

    it('given a non-Error rejection, should still log a string message without payload', async () => {
      const logError = vi.fn();
      const insert = vi.fn().mockRejectedValue('string failure');
      const buffer = createClickHouseBuffer<TestRow>('user_activities', { insert, logError });

      buffer.insert(row(1));
      await buffer.flush();

      const message = logError.mock.calls[0][0] as string;
      expect(message).toContain('string failure');
      expect(message).not.toContain('pii-payload-1');
    });
  });

  describe('drain()', () => {
    it('given pending rows, drain() should resolve only after flushing them all', async () => {
      const inserted: TestRow[][] = [];
      const insert = vi.fn().mockImplementation((params: { values: TestRow[] }) => {
        inserted.push(params.values);
        return Promise.resolve();
      });
      const buffer = createClickHouseBuffer<TestRow>('api_metrics', { insert });

      buffer.insert(row(1));
      buffer.insert(row(2));
      await buffer.drain();

      expect(inserted.flat()).toEqual([row(1), row(2)]);
      expect(buffer.pendingCount()).toBe(0);
    });

    it('given an in-flight flush plus new pending rows, drain() should await both batches', async () => {
      let resolveFirst: (() => void) | undefined;
      const insert = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveFirst = resolve;
            }),
        )
        .mockResolvedValue(undefined);
      const buffer = createClickHouseBuffer<TestRow>('api_metrics', { insert });

      buffer.insert(row(1));
      void buffer.flush(); // in-flight
      buffer.insert(row(2));

      let drained = false;
      const drainPromise = buffer.drain().then(() => {
        drained = true;
      });

      await Promise.resolve();
      expect(drained).toBe(false); // first batch still in flight

      resolveFirst?.();
      await drainPromise;

      expect(insert).toHaveBeenCalledTimes(2);
    });

    it('given an empty buffer, drain() should resolve immediately and cancel any pending timer', async () => {
      const insert = vi.fn().mockResolvedValue(undefined);
      const buffer = createClickHouseBuffer<TestRow>('api_metrics', { insert });

      buffer.insert(row(1));
      await buffer.flush();
      await buffer.drain();

      expect(vi.getTimerCount()).toBe(0);
      expect(insert).toHaveBeenCalledTimes(1);
    });
  });
});

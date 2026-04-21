import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDeltaBatcher } from '../deltaBatcher';

type FlushCall = { runId: string; text: string };

function makeHarness(overrides?: { flushIntervalMs?: number; flushCharThreshold?: number }) {
  const calls: FlushCall[] = [];
  let resolveNext: (() => void) | null = null;
  const onFlush = vi.fn<(params: FlushCall) => Promise<void>>().mockImplementation(async (p) => {
    calls.push(p);
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      await new Promise<void>((res) => {
        r();
        res();
      });
    }
  });

  const batcher = createDeltaBatcher({
    runId: 'run_abc',
    flushIntervalMs: overrides?.flushIntervalMs ?? 250,
    flushCharThreshold: overrides?.flushCharThreshold ?? 800,
    onFlush,
  });
  return { batcher, onFlush, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDeltaBatcher', () => {
  describe('defaults', () => {
    it('given no interval or threshold in options, should use built-in defaults', async () => {
      const onFlush = vi.fn<(p: { runId: string; text: string }) => Promise<void>>().mockResolvedValue();
      const batcher = createDeltaBatcher({ runId: 'run_default', onFlush });
      batcher.pushToken('x');
      expect(onFlush).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(onFlush).toHaveBeenCalledWith({ runId: 'run_default', text: 'x' });
    });
  });

  describe('buffering', () => {
    it('given a single pushToken, should not flush synchronously', () => {
      const { onFlush } = makeHarness();
      const { batcher } = makeHarness();
      batcher.pushToken('hi');
      expect(onFlush).not.toHaveBeenCalled();
    });

    it('given pushTokens under threshold and under interval, should not flush yet', () => {
      const { batcher, onFlush } = makeHarness();
      batcher.pushToken('a');
      batcher.pushToken('b');
      vi.advanceTimersByTime(100);
      expect(onFlush).not.toHaveBeenCalled();
    });
  });

  describe('time-based flush', () => {
    it('given tokens pushed and interval elapsed, should flush the accumulated text once', async () => {
      const { batcher, onFlush, calls } = makeHarness({ flushIntervalMs: 250 });
      batcher.pushToken('hel');
      batcher.pushToken('lo');
      await vi.advanceTimersByTimeAsync(250);
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(calls[0]).toEqual({ runId: 'run_abc', text: 'hello' });
    });

    it('given a second burst after a flushed batch, should start a new interval window', async () => {
      const { batcher, onFlush, calls } = makeHarness({ flushIntervalMs: 250 });
      batcher.pushToken('first');
      await vi.advanceTimersByTimeAsync(250);
      batcher.pushToken('second');
      await vi.advanceTimersByTimeAsync(250);
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(calls.map((c) => c.text)).toEqual(['first', 'second']);
    });
  });

  describe('threshold-based flush', () => {
    it('given a push that crosses the character threshold, should flush immediately without waiting for the timer', async () => {
      const { batcher, onFlush, calls } = makeHarness({ flushCharThreshold: 5 });
      batcher.pushToken('hello!'); // 6 chars
      await Promise.resolve();
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(calls[0].text).toBe('hello!');
    });

    it('given repeated threshold crossings, should flush once per crossing', async () => {
      const { batcher, onFlush } = makeHarness({ flushCharThreshold: 3 });
      batcher.pushToken('abcd');
      batcher.pushToken('efgh');
      await batcher.flush();
      expect(onFlush).toHaveBeenCalledTimes(2);
    });
  });

  describe('explicit flush()', () => {
    it('given an explicit flush with buffered text, should flush synchronously without waiting for the timer', async () => {
      const { batcher, onFlush, calls } = makeHarness();
      batcher.pushToken('abc');
      await batcher.flush();
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(calls[0].text).toBe('abc');
    });

    it('given an explicit flush with an empty buffer, should not call onFlush', async () => {
      const { batcher, onFlush } = makeHarness();
      await batcher.flush();
      expect(onFlush).not.toHaveBeenCalled();
    });

    it('given an explicit flush, should cancel the pending timer so the buffer does not double-flush', async () => {
      const { batcher, onFlush } = makeHarness({ flushIntervalMs: 250 });
      batcher.pushToken('x');
      await batcher.flush();
      await vi.advanceTimersByTimeAsync(500);
      expect(onFlush).toHaveBeenCalledTimes(1);
    });

    it('given concurrent flush calls, should serialize them so each batch is seen exactly once', async () => {
      const { batcher, onFlush, calls } = makeHarness();
      batcher.pushToken('alpha');
      const f1 = batcher.flush();
      batcher.pushToken('beta');
      const f2 = batcher.flush();
      await Promise.all([f1, f2]);
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(calls.map((c) => c.text)).toEqual(['alpha', 'beta']);
    });
  });

  describe('dispose', () => {
    it('given tokens in the buffer, should flush the remainder', async () => {
      const { batcher, onFlush, calls } = makeHarness();
      batcher.pushToken('tail');
      await batcher.dispose();
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(calls[0].text).toBe('tail');
    });

    it('given an empty buffer, should not call onFlush', async () => {
      const { batcher, onFlush } = makeHarness();
      await batcher.dispose();
      expect(onFlush).not.toHaveBeenCalled();
    });

    it('given a disposed batcher, should reject further pushes', async () => {
      const { batcher } = makeHarness();
      await batcher.dispose();
      expect(() => batcher.pushToken('late')).toThrow(/disposed/i);
    });
  });

  describe('rate bounding', () => {
    it('given tokens arriving every 20ms at 4 chars each for one second, should produce ~4 flushes not 50', async () => {
      const { batcher, onFlush } = makeHarness({ flushIntervalMs: 250, flushCharThreshold: 10_000 });
      for (let i = 0; i < 50; i++) {
        batcher.pushToken('word');
        await vi.advanceTimersByTimeAsync(20);
      }
      await batcher.flush();
      expect(onFlush.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(onFlush.mock.calls.length).toBeLessThanOrEqual(5);
    });
  });

  describe('ordering guarantees', () => {
    it('given interleaved pushes and explicit flushes, should emit text in push order across batches', async () => {
      const { batcher, calls } = makeHarness();
      batcher.pushToken('one ');
      batcher.pushToken('two ');
      await batcher.flush();
      batcher.pushToken('three ');
      await batcher.flush();
      batcher.pushToken('four');
      await batcher.dispose();
      expect(calls.map((c) => c.text)).toEqual(['one two ', 'three ', 'four']);
    });
  });
});

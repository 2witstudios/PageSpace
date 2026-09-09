/**
 * These edge cases had no coverage while this lived as a private helper inside
 * the route: the caller passes a hardcoded limit, so no test could reach a
 * non-positive one, and the guard meant to prevent a hole-filled array could be
 * deleted with every route test still green.
 */
import { describe, it, expect, vi } from 'vitest';
import { mapWithConcurrency } from '../map-with-concurrency';

const double = async (n: number) => n * 2;

describe('mapWithConcurrency', () => {
  it('maps every item, in input order', async () => {
    await expect(mapWithConcurrency([1, 2, 3, 4, 5], 2, double)).resolves.toEqual([2, 4, 6, 8, 10]);
  });

  it('returns [] for no items without calling the resolver', async () => {
    const resolve = vi.fn(double);
    await expect(mapWithConcurrency([], 4, resolve)).resolves.toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('preserves order even when later items finish first', async () => {
    const delays = [30, 20, 10, 0];
    const result = await mapWithConcurrency(delays, 4, async (delay) => {
      await new Promise((done) => setTimeout(done, delay));
      return delay;
    });
    expect(result).toEqual(delays);
  });

  // A limit that resolves to zero workers would return `new Array(n)`: typed as
  // results, actually a row of holes, with no work done and no error. A caller
  // serializing that reports every item as null. Exercised through the real
  // entry point because the guard itself is private.
  //
  // `0`/`-1`/`0.5` are the rows that pin `Math.max(1, …)`; `NaN` is the row that
  // pins the `Number.isFinite` branch (without it, `Math.min(NaN, 3)` is `NaN`
  // and `Array.from({length: NaN})` is empty). They fail for different reasons,
  // which is why both guards are listed.
  it.each([0, -1, 0.5, Number.NaN])('does the work and returns no holes for limit %p', async (limit) => {
    const resolve = vi.fn(double);
    const result = await mapWithConcurrency([1, 2, 3], limit, resolve);
    expect(resolve).toHaveBeenCalledTimes(3);
    expect(result).toEqual([2, 4, 6]);
    // `toEqual` alone passes on a hole array against [undefined, ...]; this is
    // the assertion that actually distinguishes them.
    expect(Object.keys(result)).toHaveLength(3);
  });

  // A garbage limit falls back to SERIAL — the slowest correct answer, never a
  // wrong one. Asserting the concurrency, not just the results, is what stops
  // `NaN` from silently becoming "unbounded".
  it('runs serially for a NaN limit rather than guessing a width', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2, 3, 4], Number.NaN, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((done) => setTimeout(done, 1));
      inFlight--;
      return n;
    });
    expect(peak).toBe(1);
  });

  // `Infinity` is an intent — "no ceiling" — not a bug, so it means one worker
  // per item. It used to collapse to a single serial worker, which is the
  // opposite of what the caller asked for.
  it('treats an Infinity limit as unbounded, not as serial', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5], Number.POSITIVE_INFINITY, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((done) => setTimeout(done, 1));
      inFlight--;
      return n;
    });
    expect(peak).toBe(5);
  });

  it('holds concurrency at the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 30 }, (_, i) => i), 4, async (n) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((done) => setTimeout(done, 1));
      inFlight--;
      return n;
    });
    expect(peak).toBe(4);
  });

  it('propagates the first rejection and stops claiming new work', async () => {
    let started = 0;
    const attempt = mapWithConcurrency(Array.from({ length: 40 }, (_, i) => i), 4, async (n) => {
      const mine = ++started;
      await new Promise((done) => setTimeout(done, 1));
      if (mine === 1) throw new Error('boom');
      return n;
    });

    await expect(attempt).rejects.toThrow('boom');
    await new Promise((done) => setTimeout(done, 50));
    // The four workers in flight when the first failed are the only ones that
    // ever claimed an index; the remaining 36 items are never started.
    expect(started).toBe(4);
  });

  it('catches a resolver that throws synchronously', async () => {
    await expect(
      mapWithConcurrency([1], 2, () => {
        throw new Error('sync boom');
      }),
    ).rejects.toThrow('sync boom');
  });
});

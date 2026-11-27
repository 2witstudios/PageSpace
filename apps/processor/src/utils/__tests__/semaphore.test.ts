import { describe, it, expect } from 'vitest';
import { createSemaphore, positiveIntOr } from '../semaphore';

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

/** Runs `count` tasks through the semaphore and reports the most that ran at once. */
async function peakConcurrency(limit: number, count: number): Promise<number> {
  const semaphore = createSemaphore(limit);
  let running = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: count }, () => semaphore.run(async () => {
    running++;
    peak = Math.max(peak, running);
    await tick();
    running--;
  })));
  return peak;
}

describe('createSemaphore', () => {
  it('serializes work at concurrency 1', async () => {
    expect(await peakConcurrency(1, 4)).toBe(1);
  });

  it('allows up to the limit at once', async () => {
    expect(await peakConcurrency(2, 5)).toBe(2);
  });

  it('runs waiting work in arrival order', async () => {
    const semaphore = createSemaphore(1);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => semaphore.run(async () => { await tick(); order.push(n); })));
    expect(order).toEqual([1, 2, 3]);
  });

  it('releases its slot when the work throws', async () => {
    const semaphore = createSemaphore(1);
    await expect(semaphore.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await semaphore.run(async () => 'next')).toBe('next');
  });
});

describe('positiveIntOr', () => {
  it('reads a positive integer, falling back to the default', () => {
    expect(positiveIntOr('3', 1)).toBe(3);
    expect(positiveIntOr(undefined, 1)).toBe(1);
    expect(positiveIntOr('0', 1)).toBe(1);
    expect(positiveIntOr('two', 1)).toBe(1);
  });
});

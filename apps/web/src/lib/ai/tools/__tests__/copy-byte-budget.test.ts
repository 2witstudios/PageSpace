import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createByteBudget,
  resolveCopyInflightBytes,
  DEFAULT_COPY_INFLIGHT_BYTES,
} from '../copy-byte-budget';

const MB = 1024 * 1024;

describe('createByteBudget — the process-wide in-flight byte budget for large copies', () => {
  afterEach(() => vi.useRealTimers());

  it('grants reservations while they fit, and counts what is in flight', async () => {
    const budget = createByteBudget({ capacityBytes: 100 * MB, waitMs: 1_000 });
    const a = await budget.acquire(60 * MB);
    const b = await budget.acquire(40 * MB);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(budget.inFlightBytes()).toBe(100 * MB);
    a?.();
    b?.();
    expect(budget.inFlightBytes()).toBe(0);
  });

  it('given N concurrent copies over the budget, admits what fits, queues the rest, and refuses those still waiting at the timeout', async () => {
    vi.useFakeTimers();
    const budget = createByteBudget({ capacityBytes: 512 * MB, waitMs: 2_000 });
    // Ten parallel 200 MB copies: the reviewer's OOM scenario.
    const outcomes: Array<'granted' | 'refused' | 'pending'> = Array(10).fill('pending');
    const releases: Array<() => void> = [];
    for (let i = 0; i < 10; i += 1) {
      void budget.acquire(200 * MB).then((release) => {
        outcomes[i] = release ? 'granted' : 'refused';
        if (release) releases.push(release);
      });
    }
    await vi.advanceTimersByTimeAsync(0);
    // 2 x 200 MB fit in 512 MB; a third would not.
    expect(outcomes.filter((o) => o === 'granted')).toHaveLength(2);
    expect(budget.inFlightBytes()).toBeLessThanOrEqual(512 * MB);

    // One finishes: exactly one waiter (the oldest) takes its place.
    releases[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(outcomes[2]).toBe('granted');
    expect(outcomes.filter((o) => o === 'granted')).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(outcomes.filter((o) => o === 'refused')).toHaveLength(7);
    expect(outcomes.filter((o) => o === 'pending')).toHaveLength(0);
    expect(budget.inFlightBytes()).toBeLessThanOrEqual(512 * MB);
  });

  it('serves waiters in order — a large waiter is not starved by smaller ones behind it', async () => {
    vi.useFakeTimers();
    const budget = createByteBudget({ capacityBytes: 100 * MB, waitMs: 10_000 });
    const first = await budget.acquire(90 * MB);
    const order: string[] = [];
    void budget.acquire(80 * MB).then((r) => { if (r) order.push('big'); });
    void budget.acquire(5 * MB).then((r) => { if (r) order.push('small'); });
    await vi.advanceTimersByTimeAsync(0);
    // The 5 MB would fit next to the 90 MB, but it is behind the 80 MB waiter.
    expect(order).toEqual([]);
    first?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(['big', 'small']);
  });

  it('refuses at once a reservation larger than the whole budget', async () => {
    const budget = createByteBudget({ capacityBytes: 10 * MB, waitMs: 60_000 });
    expect(await budget.acquire(11 * MB)).toBeNull();
  });

  it('a release is idempotent — releasing twice frees the bytes once', async () => {
    const budget = createByteBudget({ capacityBytes: 10 * MB, waitMs: 1_000 });
    const a = await budget.acquire(4 * MB);
    const b = await budget.acquire(4 * MB);
    a?.();
    a?.();
    expect(budget.inFlightBytes()).toBe(4 * MB);
    b?.();
  });
});

describe('resolveCopyInflightBytes', () => {
  it('defaults to 512 MB, takes a positive integer override, and ignores junk', () => {
    expect(DEFAULT_COPY_INFLIGHT_BYTES).toBe(512 * MB);
    expect(resolveCopyInflightBytes({})).toBe(512 * MB);
    expect(resolveCopyInflightBytes({ COPY_CONTENT_MAX_INFLIGHT_BYTES: '1073741824' })).toBe(1024 * MB);
    for (const raw of ['', '0', '-1', '1.5', 'lots']) {
      expect(resolveCopyInflightBytes({ COPY_CONTENT_MAX_INFLIGHT_BYTES: raw }), raw).toBe(512 * MB);
    }
  });
});

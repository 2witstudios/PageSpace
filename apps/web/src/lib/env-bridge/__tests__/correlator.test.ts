/**
 * The shared request/reply correlator — the id-correlated pending map both
 * bridges (MCP desktop, env bridge) sit on. Fake timers throughout: every
 * deadline here is asserted to the millisecond, never waited for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GrantFrame } from '@pagespace/lib/env-bridge/grant-args';
import { DEFAULT_TIMEOUT_DEFAULTS } from '@pagespace/lib/env-bridge/resolve-timeout';
import { RequestCorrelator, CorrelationError, grantCorrelatorTimeoutMs } from '../correlator';

function settled<T>(promise: Promise<T>): { state: () => 'pending' | 'resolved' | 'rejected'; value: () => T | undefined; error: () => unknown } {
  let state: 'pending' | 'resolved' | 'rejected' = 'pending';
  let value: T | undefined;
  let error: unknown;
  promise.then(
    (v) => {
      state = 'resolved';
      value = v;
    },
    (e) => {
      state = 'rejected';
      error = e;
    },
  );
  return { state: () => state, value: () => value, error: () => error };
}

const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('RequestCorrelator', () => {
  let dropped: string[];
  let correlator: RequestCorrelator<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    dropped = [];
    correlator = new RequestCorrelator<string>({ onDropped: (id) => dropped.push(id) });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('given a response for a pending id, should resolve that promise once and forget the id', async () => {
    const send = vi.fn();
    const p = settled(correlator.open({ id: 'r1', group: 'env-1', timeoutMs: 1_000, send }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(correlator.has('r1')).toBe(true);
    expect(correlator.resolve('r1', 'ok')).toBe(true);
    await flush();
    expect(p.state()).toBe('resolved');
    expect(p.value()).toBe('ok');
    expect(correlator.has('r1')).toBe(false);
    expect(correlator.pendingCount()).toBe(0);
  });

  it('given no response, should reject with a typed timeout exactly at timeoutMs and not one tick before', async () => {
    const p = settled(correlator.open({ id: 'r1', group: 'g', timeoutMs: 1_000, send: () => {} }));
    await vi.advanceTimersByTimeAsync(999);
    expect(p.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(p.state()).toBe('rejected');
    const error = p.error();
    expect(error).toBeInstanceOf(CorrelationError);
    expect((error as CorrelationError).kind).toBe('timeout');
    expect(correlator.pendingCount()).toBe(0);
  });

  it('given a grant_exec with timeoutMs 120_000, should wait at least 120 s — the MCP bridge 30 s default must not apply', async () => {
    const frame: GrantFrame = { type: 'grant_exec', grant: {}, sig: '', cmd: 'sleep', args: ['100'], timeoutMs: 120_000 };
    const timeoutMs = grantCorrelatorTimeoutMs(frame);
    expect(timeoutMs).toBe(120_000 + DEFAULT_TIMEOUT_DEFAULTS.correlatorMarginMs);
    const p = settled(correlator.open({ id: 'g1', group: 'env-1', timeoutMs, send: () => {} }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(p.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(89_999);
    expect(p.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_DEFAULTS.correlatorMarginMs + 1);
    expect(p.state()).toBe('rejected');
    expect((p.error() as CorrelationError).kind).toBe('timeout');
  });

  it('given a grant_exec without timeoutMs, should use the resolver default (120 s), never 30 s', () => {
    const frame: GrantFrame = { type: 'grant_exec', grant: {}, sig: '', cmd: 'ls' };
    expect(grantCorrelatorTimeoutMs(frame)).toBe(DEFAULT_TIMEOUT_DEFAULTS.execTimeoutMs + DEFAULT_TIMEOUT_DEFAULTS.correlatorMarginMs);
  });

  it('given a grant_pty_open, should report the channel as unbounded — no deadline is ever armed', async () => {
    const frame: GrantFrame = { type: 'grant_pty_open', grant: {}, sig: '', cols: 80, rows: 24 };
    expect(grantCorrelatorTimeoutMs(frame)).toBe('unbounded');
    const p = settled(correlator.open({ id: 'p1', group: 'env-1', timeoutMs: 'unbounded', send: () => {} }));
    await vi.advanceTimersByTimeAsync(365 * 24 * 60 * 60 * 1000);
    expect(p.state()).toBe('pending');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('given a response for an id that is not pending (late, duplicate or forged), should drop it, report it and resolve nothing', async () => {
    const p = settled(correlator.open({ id: 'r1', group: 'g', timeoutMs: 1_000, send: () => {} }));
    expect(correlator.resolve('forged', 'x')).toBe(false);
    expect(correlator.reject('forged', new Error('x'))).toBe(false);
    expect(dropped).toEqual(['forged', 'forged']);
    await flush();
    expect(p.state()).toBe('pending');
    // Duplicate: the second answer to an id already answered is dropped too.
    correlator.resolve('r1', 'first');
    expect(correlator.resolve('r1', 'second')).toBe(false);
    await flush();
    expect(p.value()).toBe('first');
    // Late: an answer after the deadline finds nothing pending.
    const late = settled(correlator.open({ id: 'r2', group: 'g', timeoutMs: 10, send: () => {} }));
    await vi.advanceTimersByTimeAsync(10);
    expect(late.state()).toBe('rejected');
    expect(correlator.resolve('r2', 'too late')).toBe(false);
  });

  it('given a send that throws, should reject with send_failed, clear the deadline and leave nothing pending', async () => {
    const p = settled(
      correlator.open({
        id: 'r1',
        group: 'g',
        timeoutMs: 1_000,
        send: () => {
          throw new Error('socket closed');
        },
      }),
    );
    await flush();
    expect(p.state()).toBe('rejected');
    expect((p.error() as CorrelationError).kind).toBe('send_failed');
    expect((p.error() as CorrelationError).message).toContain('socket closed');
    expect(correlator.pendingCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('given cancelGroup, should reject only that group with the given error and leave other groups pending', async () => {
    const a1 = settled(correlator.open({ id: 'a1', group: 'env-a', timeoutMs: 1_000, send: () => {} }));
    const a2 = settled(correlator.open({ id: 'a2', group: 'env-a', timeoutMs: 1_000, send: () => {} }));
    const b1 = settled(correlator.open({ id: 'b1', group: 'env-b', timeoutMs: 1_000, send: () => {} }));
    const cancelled = correlator.cancelGroup('env-a', new CorrelationError('disconnected', 'env-a went away'));
    await flush();
    expect(cancelled).toBe(2);
    expect(a1.state()).toBe('rejected');
    expect((a1.error() as CorrelationError).kind).toBe('disconnected');
    expect(a2.state()).toBe('rejected');
    expect(b1.state()).toBe('pending');
    expect(correlator.pendingCount()).toBe(1);
    expect(correlator.pendingCountForGroup('env-a')).toBe(0);
    // Their deadlines are gone too: nothing fires later for a cancelled request.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(b1.state()).toBe('rejected');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('should name the group a pending id belongs to, and nothing once it is answered', async () => {
    correlator.open({ id: 'r1', group: 'env-a', timeoutMs: 1_000, send: () => {} }).catch(() => {});
    expect(correlator.groupOf('r1')).toBe('env-a');
    expect(correlator.groupOf('nope')).toBeUndefined();
    correlator.resolve('r1', 'done');
    expect(correlator.groupOf('r1')).toBeUndefined();
  });

  it('given an id already pending, should reject the second open as duplicate_id and leave the first untouched', async () => {
    const first = settled(correlator.open({ id: 'r1', group: 'g', timeoutMs: 1_000, send: () => {} }));
    const send = vi.fn();
    const second = settled(correlator.open({ id: 'r1', group: 'g', timeoutMs: 1_000, send }));
    await flush();
    expect(second.state()).toBe('rejected');
    expect((second.error() as CorrelationError).kind).toBe('duplicate_id');
    expect(send).not.toHaveBeenCalled();
    expect(first.state()).toBe('pending');
    expect(correlator.pendingCount()).toBe(1);
  });

  it('given injected timers, should arm and clear deadlines through them (the clock is a dependency, not a global)', async () => {
    const armed: Array<{ fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const timers = {
      setTimeout: (fn: () => void, ms: number) => {
        armed.push({ fn, ms });
        return armed.length;
      },
      clearTimeout: (handle: unknown) => {
        cleared.push(handle);
      },
    };
    const injected = new RequestCorrelator<string>({ timers });
    const p = settled(injected.open({ id: 'r1', group: 'g', timeoutMs: 4_242, send: () => {} }));
    expect(armed).toHaveLength(1);
    expect(armed[0]!.ms).toBe(4_242);
    injected.resolve('r1', 'done');
    await flush();
    expect(p.state()).toBe('resolved');
    expect(cleared).toEqual([1]);
  });
});

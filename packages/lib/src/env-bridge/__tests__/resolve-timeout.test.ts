import { describe, it, expect } from 'vitest';
import { resolveTimeout, DEFAULT_TIMEOUT_DEFAULTS } from '../resolve-timeout';

const D = DEFAULT_TIMEOUT_DEFAULTS;

describe('resolveTimeout — the 30s bridge default must never apply to exec or PTY', () => {
  it('given exec with timeoutMs 120_000, the correlator should wait 120_000 + margin, NOT a fixed 30s', () => {
    const t = resolveTimeout({ op: 'exec', timeoutMs: 120_000 });
    expect(t).toEqual({ execTimeoutMs: 120_000, correlatorTimeoutMs: 120_000 + D.correlatorMarginMs });
    expect(t.correlatorTimeoutMs).toBeGreaterThan(30_000);
  });

  it('given exec with no timeoutMs, should use the documented default exec timeout (+ margin for the correlator)', () => {
    expect(resolveTimeout({ op: 'exec' })).toEqual({ execTimeoutMs: D.execTimeoutMs, correlatorTimeoutMs: D.execTimeoutMs + D.correlatorMarginMs });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])('given exec with a bogus timeoutMs (%s), should fall back to the default — never 0 or NaN (child_process treats those as disabled)', (bogus) => {
    const t = resolveTimeout({ op: 'exec', timeoutMs: bogus });
    expect(t.execTimeoutMs).toBe(D.execTimeoutMs);
    expect(Number.isInteger(t.correlatorTimeoutMs) && (t.correlatorTimeoutMs as number) > 0).toBe(true);
  });

  it.each(['fs_read', 'fs_write'] as const)('given %s, should behave like exec (bounded, timeoutMs honoured + margin)', (op) => {
    expect(resolveTimeout({ op, timeoutMs: 5_000 })).toEqual({ execTimeoutMs: 5_000, correlatorTimeoutMs: 5_000 + D.correlatorMarginMs });
  });

  it('given pty_open, the correlator should be unbounded (heartbeat-monitored) while the OPEN handshake itself stays bounded', () => {
    expect(resolveTimeout({ op: 'pty_open' })).toEqual({ execTimeoutMs: D.ptyOpenHandshakeMs, correlatorTimeoutMs: 'unbounded' });
  });

  it('given pty_open with a timeoutMs, should ignore it for the channel (still unbounded) — a PTY is not a command', () => {
    expect(resolveTimeout({ op: 'pty_open', timeoutMs: 1_000 }).correlatorTimeoutMs).toBe('unbounded');
  });

  it('should honour injected defaults', () => {
    const custom = { execTimeoutMs: 1_000, correlatorMarginMs: 10, ptyOpenHandshakeMs: 99 };
    expect(resolveTimeout({ op: 'exec' }, custom)).toEqual({ execTimeoutMs: 1_000, correlatorTimeoutMs: 1_010 });
    expect(resolveTimeout({ op: 'pty_open' }, custom)).toEqual({ execTimeoutMs: 99, correlatorTimeoutMs: 'unbounded' });
  });

  it('the defaults themselves must be positive integers, and the exec default must exceed the legacy 30s bridge default', () => {
    for (const v of Object.values(D)) expect(Number.isInteger(v) && v > 0).toBe(true);
    expect(D.execTimeoutMs).toBeGreaterThan(30_000);
  });
});

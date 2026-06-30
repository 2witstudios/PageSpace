import { describe, it, expect } from 'vitest';
import { outboundThrottleDecision } from '../outbound-throttle';

const limits = { maxBytesPerWindow: 1000, maxConnectionsPerWindow: 10 };

describe('outboundThrottleDecision', () => {
  it('given usage under both limits, should allow', () => {
    expect(
      outboundThrottleDecision({
        usage: { bytes: 500, connections: 5, windowMs: 60_000, elapsedMs: 10_000 },
        limits,
      }),
    ).toEqual({ action: 'allow' });
  });

  it('given a byte burst over the window limit, should throttle with the remaining window as retryAfterMs', () => {
    const decision = outboundThrottleDecision({
      usage: { bytes: 2000, connections: 1, windowMs: 60_000, elapsedMs: 10_000 },
      limits,
    });
    expect(decision).toEqual({ action: 'throttle', retryAfterMs: 50_000 });
  });

  it('given a connection burst over the window limit, should throttle', () => {
    const decision = outboundThrottleDecision({
      usage: { bytes: 1, connections: 50, windowMs: 30_000, elapsedMs: 5_000 },
      limits,
    });
    expect(decision).toMatchObject({ action: 'throttle', retryAfterMs: 25_000 });
  });

  it('given usage exactly at the limit, should allow (only EXCEEDING throttles)', () => {
    expect(
      outboundThrottleDecision({
        usage: { bytes: 1000, connections: 10, windowMs: 60_000, elapsedMs: 0 },
        limits,
      }),
    ).toEqual({ action: 'allow' });
  });

  it('given elapsed beyond the window, retryAfterMs should clamp to 0 (never negative)', () => {
    const decision = outboundThrottleDecision({
      usage: { bytes: 5000, connections: 1, windowMs: 10_000, elapsedMs: 99_000 },
      limits,
    });
    expect(decision).toEqual({ action: 'throttle', retryAfterMs: 0 });
  });

  it('should FAIL CLOSED on malformed counters (NaN/Infinity/negative → throttle, never silently under-limit)', () => {
    const windowMs = 60_000;
    const base = { connections: 1, windowMs, elapsedMs: 0 };
    // NaN bytes would make `NaN > limit` false and silently disable throttling.
    expect(outboundThrottleDecision({ usage: { ...base, bytes: NaN }, limits }).action).toBe('throttle');
    expect(outboundThrottleDecision({ usage: { ...base, bytes: Infinity }, limits }).action).toBe('throttle');
    expect(outboundThrottleDecision({ usage: { ...base, bytes: -5 }, limits }).action).toBe('throttle');
    expect(
      outboundThrottleDecision({ usage: { bytes: 1, connections: -1, windowMs, elapsedMs: 0 }, limits }).action,
    ).toBe('throttle');
    // A malformed window/elapsed must not produce a negative or NaN retryAfterMs.
    const d = outboundThrottleDecision({ usage: { bytes: 1, connections: 1, windowMs: NaN, elapsedMs: 0 }, limits });
    expect(d.action).toBe('throttle');
    if (d.action === 'throttle') expect(Number.isFinite(d.retryAfterMs) && d.retryAfterMs >= 0).toBe(true);
  });

  it('should FAIL CLOSED on a malformed LIMIT too (NaN/Infinity/negative limit → throttle, not silent allow)', () => {
    const usage = { bytes: 1, connections: 1, windowMs: 60_000, elapsedMs: 0 };
    expect(
      outboundThrottleDecision({ usage, limits: { maxBytesPerWindow: NaN, maxConnectionsPerWindow: 10 } }).action,
    ).toBe('throttle');
    expect(
      outboundThrottleDecision({ usage, limits: { maxBytesPerWindow: 1000, maxConnectionsPerWindow: -1 } }).action,
    ).toBe('throttle');
  });

  it('should be deterministic — no ambient clock (same inputs → same output)', () => {
    const input = {
      usage: { bytes: 2000, connections: 1, windowMs: 60_000, elapsedMs: 12_345 },
      limits,
    } as const;
    expect(outboundThrottleDecision(input)).toEqual(outboundThrottleDecision(input));
  });
});

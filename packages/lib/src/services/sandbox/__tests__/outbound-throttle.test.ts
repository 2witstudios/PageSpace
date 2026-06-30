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

  it('should be deterministic — no ambient clock (same inputs → same output)', () => {
    const input = {
      usage: { bytes: 2000, connections: 1, windowMs: 60_000, elapsedMs: 12_345 },
      limits,
    } as const;
    expect(outboundThrottleDecision(input)).toEqual(outboundThrottleDecision(input));
  });
});

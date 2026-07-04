import { describe, expect, it } from 'vitest';
import { computeBackoff, DEFAULT_RETRY_POLICY, isIdempotentMethod } from '../retry.js';
import type { RetryPolicy } from '../retry.js';

describe('isIdempotentMethod', () => {
  it('treats GET as idempotent', () => {
    expect(isIdempotentMethod('GET')).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('treats %s as non-idempotent', (method) => {
    expect(isIdempotentMethod(method)).toBe(false);
  });
});

describe('computeBackoff — purity and determinism', () => {
  const policy: RetryPolicy = { maxRetries: 5, baseDelayMs: 100, maxDelayMs: 2000 };

  it('is deterministic for a fixed jitter source (same inputs, same output)', () => {
    const jitter = () => 0.5;
    expect(computeBackoff(1, policy, jitter)).toBe(computeBackoff(1, policy, jitter));
    expect(computeBackoff(3, policy, jitter)).toBe(computeBackoff(3, policy, jitter));
  });

  it('grows exponentially with attempt number before the cap, scaled by jitter', () => {
    const jitter = () => 1;
    expect(computeBackoff(1, policy, jitter)).toBe(100);
    expect(computeBackoff(2, policy, jitter)).toBe(200);
    expect(computeBackoff(3, policy, jitter)).toBe(400);
  });

  it('caps exponential growth at maxDelayMs', () => {
    const jitter = () => 1;
    expect(computeBackoff(10, policy, jitter)).toBe(policy.maxDelayMs);
  });

  it('scales the (possibly capped) delay by the injected jitter fraction', () => {
    const jitter = () => 0.25;
    expect(computeBackoff(1, policy, jitter)).toBe(25);
  });

  it('rejects a non-positive attempt number', () => {
    expect(() => computeBackoff(0, policy, () => 1)).toThrow(RangeError);
    expect(() => computeBackoff(-1, policy, () => 1)).toThrow(RangeError);
  });

  it('calls the jitter source exactly once per invocation (no hidden randomness)', () => {
    let calls = 0;
    const jitter = () => {
      calls += 1;
      return 0.5;
    };
    computeBackoff(2, policy, jitter);
    expect(calls).toBe(1);
  });
});

describe('DEFAULT_RETRY_POLICY', () => {
  it('is a sane, positive policy', () => {
    expect(DEFAULT_RETRY_POLICY.maxRetries).toBeGreaterThan(0);
    expect(DEFAULT_RETRY_POLICY.baseDelayMs).toBeGreaterThan(0);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBeGreaterThanOrEqual(DEFAULT_RETRY_POLICY.baseDelayMs);
  });
});

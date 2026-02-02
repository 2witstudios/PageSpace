/**
 * Pure Rate Limit Calculation Tests
 */

import { describe, it, expect } from 'vitest';
import { calculateEffectiveRateLimit } from './calculate-limit';

describe('calculateEffectiveRateLimit', () => {
  it('given no rate limits, should return default 30/min', () => {
    const result = calculateEffectiveRateLimit({});

    expect(result).toBe(30);
  });

  it('given provider-level limit only, should use provider limit', () => {
    const result = calculateEffectiveRateLimit({
      provider: { requests: 60, windowMs: 60000 }, // 60 per minute
    });

    expect(result).toBe(60);
  });

  it('given provider limit with different window, should normalize to per-minute', () => {
    const result = calculateEffectiveRateLimit({
      provider: { requests: 10, windowMs: 10000 }, // 10 per 10 seconds = 60 per minute
    });

    expect(result).toBe(60);
  });

  it('given connection-level limit, should use most restrictive of provider and connection', () => {
    const result = calculateEffectiveRateLimit({
      provider: { requests: 100, windowMs: 60000 }, // 100/min
      connection: { requestsPerMinute: 50 }, // 50/min
    });

    expect(result).toBe(50); // Most restrictive
  });

  it('given grant-level override, should use most restrictive of all levels', () => {
    const result = calculateEffectiveRateLimit({
      provider: { requests: 100, windowMs: 60000 }, // 100/min
      connection: { requestsPerMinute: 50 }, // 50/min
      grant: { requestsPerMinute: 20 }, // 20/min
    });

    expect(result).toBe(20); // Most restrictive
  });

  it('given tool-specific limit, should factor into calculation', () => {
    const result = calculateEffectiveRateLimit({
      provider: { requests: 100, windowMs: 60000 }, // 100/min
      connection: { requestsPerMinute: 50 }, // 50/min
      tool: { requests: 5, windowMs: 60000 }, // 5/min (most restrictive)
    });

    expect(result).toBe(5);
  });

  it('given grant less restrictive than provider, should use provider', () => {
    const result = calculateEffectiveRateLimit({
      provider: { requests: 30, windowMs: 60000 }, // 30/min
      grant: { requestsPerMinute: 100 }, // 100/min (less restrictive)
    });

    expect(result).toBe(30); // Provider is more restrictive
  });

  it('given only connection limit, should use it', () => {
    const result = calculateEffectiveRateLimit({
      connection: { requestsPerMinute: 45 },
    });

    expect(result).toBe(45);
  });

  it('given undefined grant requestsPerMinute, should ignore grant', () => {
    const result = calculateEffectiveRateLimit({
      provider: { requests: 60, windowMs: 60000 },
      grant: {}, // No requestsPerMinute
    });

    expect(result).toBe(60);
  });
});

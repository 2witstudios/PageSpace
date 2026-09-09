import { describe, expect, it } from 'vitest';
import {
  CHAIN_LEAD_MS,
  MIN_CHAIN_DELAY_MS,
  chainDelayMs,
} from '../chain-schedule';

describe('chainDelayMs', () => {
  it('given the default 10-minute cap, should chain a lead time before it', () => {
    expect(chainDelayMs(600_000)).toBe(600_000 - CHAIN_LEAD_MS);
  });

  it('given the hour-long socket ceiling, should still chain ahead of it', () => {
    expect(chainDelayMs(3_600_000)).toBe(3_600_000 - CHAIN_LEAD_MS);
  });

  it('given no cap reported, should not chain', () => {
    // Nothing known to get ahead of — chaining on a guess would churn calls.
    expect(chainDelayMs(undefined)).toBeUndefined();
  });

  it('given a nonsensical cap, should not chain', () => {
    expect(chainDelayMs(0)).toBeUndefined();
    expect(chainDelayMs(-1)).toBeUndefined();
    expect(chainDelayMs(Number.NaN)).toBeUndefined();
    expect(chainDelayMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it('given a cap too short to get ahead of, should not chain', () => {
    // A handshake needs more headroom than the whole call has left; the honest
    // outcome is one call that ends at its cap, not a session spent handing off.
    expect(chainDelayMs(CHAIN_LEAD_MS + MIN_CHAIN_DELAY_MS - 1)).toBeUndefined();
  });

  it('given a cap exactly at the churn floor, should chain', () => {
    expect(chainDelayMs(CHAIN_LEAD_MS + MIN_CHAIN_DELAY_MS)).toBe(
      MIN_CHAIN_DELAY_MS,
    );
  });

  it('given explicit lead and floor overrides, should honour them', () => {
    expect(chainDelayMs(100_000, 10_000, 1_000)).toBe(90_000);
    expect(chainDelayMs(100_000, 10_000, 95_000)).toBeUndefined();
  });
});

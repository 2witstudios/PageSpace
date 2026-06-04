import { describe, it, expect } from 'vitest';
import {
  isMemoryAvailable,
  resolvePulseEnabled,
  filterPulseEligible,
  validateAutomationPatch,
  buildAutomationView,
} from '../automation-preferences';

describe('isMemoryAvailable', () => {
  it('is true only for paid tiers', () => {
    expect(isMemoryAvailable('pro')).toBe(true);
    expect(isMemoryAvailable('founder')).toBe(true);
    expect(isMemoryAvailable('business')).toBe(true);
  });
  it('is false for free', () => {
    expect(isMemoryAvailable('free')).toBe(false);
  });
});

describe('resolvePulseEnabled', () => {
  it('defaults to enabled when no row exists', () => {
    expect(resolvePulseEnabled(undefined)).toBe(true);
    expect(resolvePulseEnabled(null)).toBe(true);
  });
  it('honors the stored flag', () => {
    expect(resolvePulseEnabled({ pulseEnabled: false })).toBe(false);
    expect(resolvePulseEnabled({ pulseEnabled: true })).toBe(true);
  });
});

describe('filterPulseEligible', () => {
  it('keeps users with no preference row (default enabled)', () => {
    expect(filterPulseEligible(['a', 'b'], [])).toEqual(['a', 'b']);
  });
  it('drops only users whose row disables pulse', () => {
    const rows = [
      { userId: 'a', pulseEnabled: false },
      { userId: 'b', pulseEnabled: true },
    ];
    expect(filterPulseEligible(['a', 'b', 'c'], rows)).toEqual(['b', 'c']);
  });
  it('preserves input order and dedupes nothing it was not given', () => {
    const rows = [{ userId: 'x', pulseEnabled: false }];
    expect(filterPulseEligible(['x'], rows)).toEqual([]);
  });
});

describe('validateAutomationPatch', () => {
  it('rejects when no recognized field is present', () => {
    const r = validateAutomationPatch({}, 'pro');
    expect('error' in r).toBe(true);
    expect((r as { status: number }).status).toBe(400);
  });
  it('rejects non-boolean values', () => {
    expect('error' in validateAutomationPatch({ pulseEnabled: 'yes' }, 'pro')).toBe(true);
    expect('error' in validateAutomationPatch({ memoryEnabled: 1 }, 'pro')).toBe(true);
  });
  it('rejects a non-object body', () => {
    expect('error' in validateAutomationPatch(null, 'pro')).toBe(true);
    expect('error' in validateAutomationPatch([], 'pro')).toBe(true);
  });
  it('rejects enabling memory on a free tier with 403', () => {
    const r = validateAutomationPatch({ memoryEnabled: true }, 'free');
    expect('error' in r).toBe(true);
    expect((r as { status: number }).status).toBe(403);
  });
  it('allows disabling memory on free (turning off is always fine)', () => {
    expect(validateAutomationPatch({ memoryEnabled: false }, 'free')).toEqual({ memory: false });
  });
  it('allows enabling memory on a paid tier', () => {
    expect(validateAutomationPatch({ memoryEnabled: true }, 'pro')).toEqual({ memory: true });
  });
  it('allows pulse toggles on any tier', () => {
    expect(validateAutomationPatch({ pulseEnabled: false }, 'free')).toEqual({ pulse: false });
    expect(validateAutomationPatch({ pulseEnabled: true }, 'free')).toEqual({ pulse: true });
  });
  it('accepts both fields together', () => {
    expect(validateAutomationPatch({ pulseEnabled: false, memoryEnabled: true }, 'business'))
      .toEqual({ pulse: false, memory: true });
  });
});

describe('buildAutomationView', () => {
  it('reports pulse default-on and memory unavailable for free', () => {
    expect(buildAutomationView(undefined, undefined, 'free')).toEqual({
      pulse: { enabled: true },
      memory: { enabled: true, available: false },
    });
  });
  it('reflects stored flags for a paid user', () => {
    const view = buildAutomationView(
      { pulseEnabled: false },
      { enabled: false },
      'pro',
    );
    expect(view).toEqual({
      pulse: { enabled: false },
      memory: { enabled: false, available: true },
    });
  });
  it('defaults memory.enabled to true when no personalization row exists', () => {
    const view = buildAutomationView(undefined, undefined, 'business');
    expect(view.memory).toEqual({ enabled: true, available: true });
  });
});

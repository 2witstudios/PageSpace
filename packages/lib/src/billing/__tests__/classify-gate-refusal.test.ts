/**
 * Scheduled AI runs (workflows, task triggers, calendar occurrences) must tell a
 * refusal that clears on its own from one that needs a human: retrying a
 * transient refusal next tick is correct, retrying a terminal one is noise. Pure.
 */
import { describe, it, expect } from 'vitest';
import { classifyGateRefusal } from '../classify-gate-refusal';

describe('classifyGateRefusal', () => {
  it('given too_many_in_flight, should be transient (another call will finish)', () => {
    expect(classifyGateRefusal('too_many_in_flight')).toBe('transient');
  });

  it('given daily_cap_exceeded, should be terminal (nothing clears it until the UTC day rolls, so retrying every tick is noise)', () => {
    expect(classifyGateRefusal('daily_cap_exceeded')).toBe('terminal');
  });

  it('given out_of_credits, should be terminal (someone must add credits)', () => {
    expect(classifyGateRefusal('out_of_credits')).toBe('terminal');
  });

  it('given requires_funding, should be terminal (a human must claim the agent)', () => {
    expect(classifyGateRefusal('requires_funding')).toBe('terminal');
  });

  it('given needs_init (including a missing users row), should be terminal', () => {
    expect(classifyGateRefusal('needs_init')).toBe('terminal');
  });
});

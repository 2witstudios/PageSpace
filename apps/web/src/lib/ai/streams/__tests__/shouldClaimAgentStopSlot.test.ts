import { describe, it, expect } from 'vitest';
import { shouldClaimAgentStopSlot } from '../shouldClaimAgentStopSlot';

describe('shouldClaimAgentStopSlot', () => {
  it('given an empty slot, should claim', () => {
    expect(shouldClaimAgentStopSlot(null)).toBe(true);
  });

  it('given a populated slot, should not claim (so the first writer for THIS agent is preserved)', () => {
    expect(shouldClaimAgentStopSlot(() => {})).toBe(false);
  });

  // The store is keyed by agent, so the caller looks up its OWN agent's stop before asking.
  // Another agent's stop is not reachable here at all — which is what stops one agent's
  // stream from blocking (or hijacking) another's Stop button.
  it('given an async stop fn, should still not claim (the void-return trap must not hide it)', () => {
    expect(shouldClaimAgentStopSlot(async () => {})).toBe(false);
  });
});

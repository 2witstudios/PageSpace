import { describe, it, expect } from 'vitest';
import { shouldClaimAgentStopSlot } from '../shouldClaimAgentStopSlot';

describe('shouldClaimAgentStopSlot', () => {
  it('given an empty slot, should claim', () => {
    expect(shouldClaimAgentStopSlot(null)).toBe(true);
  });

  it('given a populated slot, should not claim (so the first writer is preserved)', () => {
    const existingStop = () => {};
    expect(shouldClaimAgentStopSlot(existingStop)).toBe(false);
  });

  it('given a populated slot whose function is a no-op, should still not claim', () => {
    expect(shouldClaimAgentStopSlot(() => undefined)).toBe(false);
  });
});

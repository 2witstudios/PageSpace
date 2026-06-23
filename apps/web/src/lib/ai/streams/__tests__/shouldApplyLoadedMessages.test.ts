import { describe, it, expect } from 'vitest';
import { shouldApplyLoadedMessages } from '../shouldApplyLoadedMessages';

describe('shouldApplyLoadedMessages', () => {
  it('returns true when the requested id matches the in-flight id', () => {
    expect(shouldApplyLoadedMessages('conv-1', 'conv-1')).toBe(true);
  });

  it('returns false when the requested id differs from the in-flight id (stale response)', () => {
    expect(shouldApplyLoadedMessages('conv-1', 'conv-2')).toBe(false);
  });

  it('returns false when the in-flight id is null (no active request)', () => {
    expect(shouldApplyLoadedMessages('conv-1', null)).toBe(false);
  });

  it('returns true for any equal non-empty string pair', () => {
    expect(shouldApplyLoadedMessages('abc-def-123', 'abc-def-123')).toBe(true);
  });
});

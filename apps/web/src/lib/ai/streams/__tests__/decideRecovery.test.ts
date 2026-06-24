import { describe, it, expect } from 'vitest';
import { decideRecovery } from '../decideRecovery';

describe('decideRecovery', () => {
  it('live stream → rejoin (highest priority, stream is still running)', () => {
    expect(decideRecovery({ hasLiveStream: true, hasPersistedReply: false })).toBe('rejoin');
  });

  it('live stream + persisted reply → rejoin (stream takes precedence)', () => {
    expect(decideRecovery({ hasLiveStream: true, hasPersistedReply: true })).toBe('rejoin');
  });

  it('no live stream + persisted reply → refetch (run finished while backgrounded)', () => {
    expect(decideRecovery({ hasLiveStream: false, hasPersistedReply: true })).toBe('refetch');
  });

  it('no live stream + no persisted reply → regenerate (genuine failure, nothing to recover)', () => {
    expect(decideRecovery({ hasLiveStream: false, hasPersistedReply: false })).toBe('regenerate');
  });
});

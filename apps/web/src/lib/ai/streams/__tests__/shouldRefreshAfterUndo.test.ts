import { describe, it, expect } from 'vitest';
import { shouldRefreshAfterUndo } from '../shouldRefreshAfterUndo';

describe('shouldRefreshAfterUndo', () => {
  it('given a payload from a different browserSessionId whose conversationId matches the surface, should return true', () => {
    const payload = {
      conversationId: 'conv-1',
      triggeredBy: { browserSessionId: 'session-other' },
    };
    expect(shouldRefreshAfterUndo(payload, 'conv-1', 'session-mine')).toBe(true);
  });

  it('given a payload from the local browserSessionId, should return false (originator already refreshed)', () => {
    const payload = {
      conversationId: 'conv-1',
      triggeredBy: { browserSessionId: 'session-mine' },
    };
    expect(shouldRefreshAfterUndo(payload, 'conv-1', 'session-mine')).toBe(false);
  });

  it('given a payload whose conversationId differs from the surface, should return false (cross-conversation isolation)', () => {
    const payload = {
      conversationId: 'conv-other',
      triggeredBy: { browserSessionId: 'session-other' },
    };
    expect(shouldRefreshAfterUndo(payload, 'conv-1', 'session-mine')).toBe(false);
  });

  it('given a null currentConversationId, should return false (surface has no active conversation)', () => {
    const payload = {
      conversationId: 'conv-1',
      triggeredBy: { browserSessionId: 'session-other' },
    };
    expect(shouldRefreshAfterUndo(payload, null, 'session-mine')).toBe(false);
  });
});

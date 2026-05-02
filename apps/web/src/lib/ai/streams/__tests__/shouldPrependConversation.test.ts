import { describe, it, expect } from 'vitest';
import { shouldPrependConversation } from '../shouldPrependConversation';

describe('shouldPrependConversation', () => {
  it('given a payload from a different browserSessionId whose id is not in the existing list, should return true', () => {
    const payload = {
      conversation: { id: 'conv-new' },
      triggeredBy: { browserSessionId: 'session-other' },
    };
    expect(shouldPrependConversation(payload, 'session-mine', [{ id: 'conv-1' }])).toBe(true);
  });

  it('given a payload from the local browserSessionId, should return false (originator already added optimistically)', () => {
    const payload = {
      conversation: { id: 'conv-new' },
      triggeredBy: { browserSessionId: 'session-mine' },
    };
    expect(shouldPrependConversation(payload, 'session-mine', [{ id: 'conv-1' }])).toBe(false);
  });

  it('given a payload whose conversation id is already in the existing list, should return false (race-condition dedup)', () => {
    const payload = {
      conversation: { id: 'conv-new' },
      triggeredBy: { browserSessionId: 'session-other' },
    };
    expect(
      shouldPrependConversation(payload, 'session-mine', [{ id: 'conv-1' }, { id: 'conv-new' }]),
    ).toBe(false);
  });

  it('given an empty existing conversations list, should return true (first-conversation case)', () => {
    const payload = {
      conversation: { id: 'conv-new' },
      triggeredBy: { browserSessionId: 'session-other' },
    };
    expect(shouldPrependConversation(payload, 'session-mine', [])).toBe(true);
  });
});

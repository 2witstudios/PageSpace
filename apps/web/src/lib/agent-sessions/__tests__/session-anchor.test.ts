import { describe, it, expect } from 'vitest';
import { sessionAnchorForConversation } from '../session-anchor';

describe('sessionAnchorForConversation', () => {
  it('given a page conversation, should anchor to its agent page', () => {
    expect(sessionAnchorForConversation({ type: 'page', contextId: 'page-1' })).toEqual({
      ok: true,
      agentPageId: 'page-1',
    });
  });

  it('given a global conversation, should anchor as a global-assistant session', () => {
    expect(sessionAnchorForConversation({ type: 'global', contextId: null })).toEqual({
      ok: true,
      agentPageId: null,
    });
  });

  it('given a drive conversation, should refuse — it cannot host a session', () => {
    expect(sessionAnchorForConversation({ type: 'drive', contextId: 'drive-1' })).toEqual({
      ok: false,
      reason: 'unsupported_conversation_type',
    });
  });

  it('given a page conversation that lost its contextId, should refuse rather than anchor to nothing', () => {
    expect(sessionAnchorForConversation({ type: 'page', contextId: null })).toEqual({
      ok: false,
      reason: 'unsupported_conversation_type',
    });
    expect(sessionAnchorForConversation({ type: 'page', contextId: '' })).toEqual({
      ok: false,
      reason: 'unsupported_conversation_type',
    });
  });
});

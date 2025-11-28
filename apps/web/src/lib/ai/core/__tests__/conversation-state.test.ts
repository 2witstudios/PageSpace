import { describe, it, expect, beforeEach } from 'vitest';
import { conversationState } from '../conversation-state';

describe('conversationState agent methods', () => {
  beforeEach(() => {
    // Clear cookies before each test
    document.cookie = 'activeAgentId=; max-age=0; path=/';
    document.cookie = 'activeConversationId=; max-age=0; path=/';
  });

  it('should set and get agent ID', () => {
    conversationState.setActiveAgentId('agent_123');
    expect(conversationState.getActiveAgentId()).toBe('agent_123');
  });

  it('should clear agent when set to null', () => {
    conversationState.setActiveAgentId('agent_123');
    expect(conversationState.getActiveAgentId()).toBe('agent_123');

    conversationState.setActiveAgentId(null);
    expect(conversationState.getActiveAgentId()).toBeNull();
  });
});

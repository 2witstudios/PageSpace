import { describe, it, expect, beforeEach } from 'vitest';
import {
  getConversationId,
  getAgentId,
  setConversationId,
  setAgentId,
  clearConversationId,
  clearAgentId,
  setChatParams,
} from '../url-state';

describe('url-state', () => {
  beforeEach(() => {
    // Reset URL to base state
    window.history.replaceState({}, '', '/');
  });

  describe('getConversationId', () => {
    it('should return conversation id from URL params', () => {
      window.history.replaceState({}, '', '/?c=conv-123');
      expect(getConversationId()).toBe('conv-123');
    });

    it('should return null when not present', () => {
      expect(getConversationId()).toBeNull();
    });
  });

  describe('getAgentId', () => {
    it('should return agent id from URL params', () => {
      window.history.replaceState({}, '', '/?agent=agent-456');
      expect(getAgentId()).toBe('agent-456');
    });

    it('should return null when not present', () => {
      expect(getAgentId()).toBeNull();
    });
  });

  describe('setConversationId', () => {
    it('should set conversation id in URL', () => {
      setConversationId('conv-789');
      expect(new URLSearchParams(window.location.search).get('c')).toBe('conv-789');
    });

    it('should remove conversation id when set to null', () => {
      setConversationId('conv-789');
      setConversationId(null);
      expect(new URLSearchParams(window.location.search).get('c')).toBeNull();
    });

    it('should use replace mode when specified', () => {
      setConversationId('conv-1', 'replace');
      expect(new URLSearchParams(window.location.search).get('c')).toBe('conv-1');
    });
  });

  describe('setAgentId', () => {
    it('should set agent id in URL', () => {
      setAgentId('agent-1');
      expect(new URLSearchParams(window.location.search).get('agent')).toBe('agent-1');
    });

    it('should remove agent id when set to null', () => {
      setAgentId('agent-1');
      setAgentId(null);
      expect(new URLSearchParams(window.location.search).get('agent')).toBeNull();
    });
  });

  describe('clearConversationId', () => {
    it('should remove conversation id from URL', () => {
      setConversationId('conv-1');
      clearConversationId();
      expect(new URLSearchParams(window.location.search).get('c')).toBeNull();
    });
  });

  describe('clearAgentId', () => {
    it('should remove agent id from URL', () => {
      setAgentId('agent-1');
      clearAgentId();
      expect(new URLSearchParams(window.location.search).get('agent')).toBeNull();
    });
  });

  describe('setChatParams', () => {
    it('should set both conversation and agent params', () => {
      setChatParams({ conversationId: 'conv-1', agentId: 'agent-1' });
      const params = new URLSearchParams(window.location.search);
      expect(params.get('c')).toBe('conv-1');
      expect(params.get('agent')).toBe('agent-1');
    });

    it('should only set provided params', () => {
      setChatParams({ conversationId: 'conv-1' });
      expect(new URLSearchParams(window.location.search).get('c')).toBe('conv-1');
      expect(new URLSearchParams(window.location.search).get('agent')).toBeNull();
    });

    it('should use replace mode when specified', () => {
      setChatParams({ conversationId: 'conv-1' }, 'replace');
      expect(new URLSearchParams(window.location.search).get('c')).toBe('conv-1');
    });
  });
});

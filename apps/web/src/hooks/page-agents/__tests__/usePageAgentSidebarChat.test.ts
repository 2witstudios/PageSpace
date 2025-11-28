/**
 * usePageAgentSidebarChat Hook Tests
 * Tests for unified chat interface supporting both global and agent modes
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePageAgentSidebarChat } from '../usePageAgentSidebarChat';
import type { SidebarAgentInfo } from '../usePageAgentSidebarState';

// Mock useChat from @ai-sdk/react
const mockGlobalSendMessage = vi.fn();
const mockGlobalRegenerate = vi.fn();
const mockGlobalStop = vi.fn();
const mockGlobalSetMessages = vi.fn();

const mockAgentSendMessage = vi.fn();
const mockAgentRegenerate = vi.fn();
const mockAgentStop = vi.fn();
const mockAgentSetMessages = vi.fn();

// Track which chat instance is being used
let useChatCallCount = 0;

vi.mock('@ai-sdk/react', () => ({
  useChat: vi.fn(() => {
    useChatCallCount++;
    // First call is for global chat, second is for agent chat
    if (useChatCallCount % 2 === 1) {
      return {
        messages: [],
        sendMessage: mockGlobalSendMessage,
        status: 'ready' as const,
        error: undefined,
        regenerate: mockGlobalRegenerate,
        setMessages: mockGlobalSetMessages,
        stop: mockGlobalStop,
      };
    } else {
      return {
        messages: [],
        sendMessage: mockAgentSendMessage,
        status: 'ready' as const,
        error: undefined,
        regenerate: mockAgentRegenerate,
        setMessages: mockAgentSetMessages,
        stop: mockAgentStop,
      };
    }
  }),
}));

describe('usePageAgentSidebarChat', () => {
  // Sample agent
  const mockAgent: SidebarAgentInfo = {
    id: 'agent-123',
    title: 'Test Agent',
    driveId: 'drive-456',
    driveName: 'Test Drive',
  };

  // Sample chat configs
  const mockGlobalChatConfig = {
    id: 'global-conv-123',
    messages: [],
    experimental_throttle: 50,
  };

  const mockAgentChatConfig = {
    id: 'agent-conv-456',
    messages: [],
    experimental_throttle: 50,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useChatCallCount = 0;
  });

  // ============================================
  // Unified Interface Tests
  // ============================================
  describe('unified interface', () => {
    it('should return messages from global chat when no agent selected', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: null,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: null,
        })
      );

      expect(result.current.messages).toEqual([]);
      expect(result.current.status).toBe('ready');
      expect(result.current.error).toBeUndefined();
      expect(result.current.isStreaming).toBe(false);
    });

    it('should return sendMessage function', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: null,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: null,
        })
      );

      expect(typeof result.current.sendMessage).toBe('function');
    });

    it('should return stop function', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: null,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: null,
        })
      );

      expect(typeof result.current.stop).toBe('function');
    });

    it('should return regenerate function', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: null,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: null,
        })
      );

      expect(typeof result.current.regenerate).toBe('function');
    });

    it('should return setMessages function', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: null,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: null,
        })
      );

      expect(typeof result.current.setMessages).toBe('function');
    });
  });

  // ============================================
  // Global Mode Tests
  // ============================================
  describe('global mode (no agent selected)', () => {
    it('should use global sendMessage when sending in global mode', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: null,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: null,
        })
      );

      act(() => {
        result.current.sendMessage({ text: 'Hello' });
      });

      expect(mockGlobalSendMessage).toHaveBeenCalledWith({ text: 'Hello' }, undefined);
      expect(mockAgentSendMessage).not.toHaveBeenCalled();
    });

    it('should use global regenerate in global mode', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: null,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: null,
        })
      );

      act(() => {
        result.current.regenerate();
      });

      expect(mockGlobalRegenerate).toHaveBeenCalled();
      expect(mockAgentRegenerate).not.toHaveBeenCalled();
    });

    it('should expose globalStatus for context sync', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: null,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: null,
        })
      );

      expect(result.current.globalStatus).toBe('ready');
    });

    it('should expose globalMessages for context sync', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: null,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: null,
        })
      );

      expect(result.current.globalMessages).toEqual([]);
    });

    it('should expose setGlobalMessages for context sync', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: null,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: null,
        })
      );

      expect(typeof result.current.setGlobalMessages).toBe('function');
    });
  });

  // ============================================
  // Agent Mode Tests
  // ============================================
  describe('agent mode (agent selected)', () => {
    it('should use agent sendMessage when agent is selected', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: mockAgent,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: mockAgentChatConfig,
        })
      );

      act(() => {
        result.current.sendMessage({ text: 'Hello Agent' }, { body: { test: true } });
      });

      expect(mockAgentSendMessage).toHaveBeenCalledWith(
        { text: 'Hello Agent' },
        { body: { test: true } }
      );
      expect(mockGlobalSendMessage).not.toHaveBeenCalled();
    });

    it('should use agent regenerate in agent mode', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: mockAgent,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: mockAgentChatConfig,
        })
      );

      act(() => {
        result.current.regenerate();
      });

      expect(mockAgentRegenerate).toHaveBeenCalled();
      expect(mockGlobalRegenerate).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // isStreaming Tests
  // ============================================
  describe('isStreaming calculation', () => {
    // Note: The hook calculates isStreaming based on status.
    // Since status is always 'ready' in our mock, isStreaming is always false.
    // More comprehensive streaming tests would require a dynamic mock setup.

    it('should be false when status is ready (default mock)', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: null,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: null,
        })
      );

      // Our mock returns 'ready' status
      expect(result.current.isStreaming).toBe(false);
      expect(result.current.status).toBe('ready');
    });

    it('should calculate isStreaming based on status value', () => {
      // Test the isStreaming logic pattern:
      // isStreaming = status === 'submitted' || status === 'streaming'
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: null,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: null,
        })
      );

      // With status 'ready', isStreaming should be false
      expect(result.current.status).toBe('ready');
      expect(result.current.isStreaming).toBe(false);
    });
  });

  // ============================================
  // Return Type Stability Tests
  // ============================================
  describe('return type stability', () => {
    it('should include all required properties', () => {
      const { result } = renderHook(() =>
        usePageAgentSidebarChat({
          selectedAgent: null,
          globalChatConfig: mockGlobalChatConfig,
          agentChatConfig: null,
        })
      );

      expect(result.current).toHaveProperty('messages');
      expect(result.current).toHaveProperty('sendMessage');
      expect(result.current).toHaveProperty('status');
      expect(result.current).toHaveProperty('error');
      expect(result.current).toHaveProperty('regenerate');
      expect(result.current).toHaveProperty('setMessages');
      expect(result.current).toHaveProperty('stop');
      expect(result.current).toHaveProperty('isStreaming');
      expect(result.current).toHaveProperty('globalStatus');
      expect(result.current).toHaveProperty('globalStop');
      expect(result.current).toHaveProperty('globalMessages');
      expect(result.current).toHaveProperty('setGlobalMessages');
    });
  });
});

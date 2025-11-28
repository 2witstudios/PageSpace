/**
 * useAgentStore Tests
 * Tests for centralized agent state management (dashboard context)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAgentStore, type AgentInfo, type SidebarTab } from '../useAgentStore';

// Mock fetchWithAuth
const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

// Mock conversationState
vi.mock('@/lib/ai/conversation-state', () => ({
  conversationState: {
    getActiveAgentId: vi.fn(() => null),
    setActiveAgentId: vi.fn(),
  },
}));

// Mock toast
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock window.location and history
const mockPushState = vi.fn();
const mockReplaceState = vi.fn();

describe('useAgentStore', () => {
  const mockAgent: AgentInfo = {
    id: 'agent-123',
    title: 'Test Agent',
    driveId: 'drive-456',
    driveName: 'Test Drive',
    systemPrompt: 'You are helpful',
    aiProvider: 'openai',
    aiModel: 'gpt-4',
    enabledTools: ['search'],
  };

  const mockAgent2: AgentInfo = {
    id: 'agent-789',
    title: 'Another Agent',
    driveId: 'drive-456',
    driveName: 'Test Drive',
  };

  beforeEach(() => {
    // Reset the store state before each test
    useAgentStore.setState({
      selectedAgent: null,
      isInitialized: false,
      conversationId: null,
      conversationMessages: [],
      isConversationLoading: false,
      conversationAgentId: null,
      activeTab: 'history',
    });

    // Clear all mocks
    vi.clearAllMocks();

    // Mock window.location
    Object.defineProperty(window, 'location', {
      value: {
        href: 'http://localhost:3000/dashboard',
        search: '',
      },
      writable: true,
    });

    // Mock history.pushState and replaceState
    window.history.pushState = mockPushState;
    window.history.replaceState = mockReplaceState;

    // Default fetch mock
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ conversations: [] }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ============================================
  // Initial State Tests
  // ============================================
  describe('initial state', () => {
    it('should have null selectedAgent', () => {
      const { result } = renderHook(() => useAgentStore());
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should not be initialized', () => {
      const { result } = renderHook(() => useAgentStore());
      expect(result.current.isInitialized).toBe(false);
    });

    it('should have history as default activeTab', () => {
      const { result } = renderHook(() => useAgentStore());
      expect(result.current.activeTab).toBe('history');
    });

    it('should have null conversationId', () => {
      const { result } = renderHook(() => useAgentStore());
      expect(result.current.conversationId).toBeNull();
    });

    it('should have empty conversationMessages', () => {
      const { result } = renderHook(() => useAgentStore());
      expect(result.current.conversationMessages).toEqual([]);
    });
  });

  // ============================================
  // setActiveTab Tests
  // ============================================
  describe('setActiveTab', () => {
    it('should update activeTab to history', () => {
      const { result } = renderHook(() => useAgentStore());

      act(() => {
        result.current.setActiveTab('history');
      });

      expect(result.current.activeTab).toBe('history');
    });

    it('should update activeTab to settings', () => {
      const { result } = renderHook(() => useAgentStore());

      act(() => {
        result.current.setActiveTab('settings');
      });

      expect(result.current.activeTab).toBe('settings');
    });

    it('should update activeTab to chat', () => {
      const { result } = renderHook(() => useAgentStore());

      act(() => {
        result.current.setActiveTab('chat');
      });

      expect(result.current.activeTab).toBe('chat');
    });

    it('should preserve other state when changing tabs', () => {
      const { result } = renderHook(() => useAgentStore());

      // Set up some state
      act(() => {
        result.current.selectAgent(mockAgent);
      });

      const agentBefore = result.current.selectedAgent;

      act(() => {
        result.current.setActiveTab('settings');
      });

      expect(result.current.selectedAgent).toEqual(agentBefore);
      expect(result.current.activeTab).toBe('settings');
    });
  });

  // ============================================
  // selectAgent Tests
  // ============================================
  describe('selectAgent', () => {
    it('should select an agent', () => {
      const { result } = renderHook(() => useAgentStore());

      act(() => {
        result.current.selectAgent(mockAgent);
      });

      expect(result.current.selectedAgent).toEqual(mockAgent);
    });

    it('should deselect agent when passing null', () => {
      const { result } = renderHook(() => useAgentStore());

      act(() => {
        result.current.selectAgent(mockAgent);
      });
      expect(result.current.selectedAgent).toEqual(mockAgent);

      act(() => {
        result.current.selectAgent(null);
      });
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should clear conversation state when switching agents', () => {
      const { result } = renderHook(() => useAgentStore());

      // Set up initial agent with conversation
      useAgentStore.setState({
        selectedAgent: mockAgent,
        conversationId: 'conv-123',
        conversationMessages: [{ id: 'msg-1', role: 'user', content: 'Hello' }] as never[],
        conversationAgentId: mockAgent.id,
      });

      // Switch to different agent
      act(() => {
        result.current.selectAgent(mockAgent2);
      });

      expect(result.current.selectedAgent).toEqual(mockAgent2);
      expect(result.current.conversationId).toBeNull();
      expect(result.current.conversationMessages).toEqual([]);
      expect(result.current.conversationAgentId).toBeNull();
    });

    it('should not clear conversation when selecting same agent', () => {
      const { result } = renderHook(() => useAgentStore());

      // Set up initial agent with conversation
      useAgentStore.setState({
        selectedAgent: mockAgent,
        conversationId: 'conv-123',
        conversationMessages: [{ id: 'msg-1', role: 'user', content: 'Hello' }] as never[],
        conversationAgentId: mockAgent.id,
      });

      // Select same agent again
      act(() => {
        result.current.selectAgent(mockAgent);
      });

      expect(result.current.conversationId).toBe('conv-123');
    });
  });

  // ============================================
  // setConversationMessages Tests
  // ============================================
  describe('setConversationMessages', () => {
    it('should update conversation messages', () => {
      const { result } = renderHook(() => useAgentStore());

      const messages = [
        { id: 'msg-1', role: 'user', content: 'Hello' },
        { id: 'msg-2', role: 'assistant', content: 'Hi!' },
      ] as never[];

      act(() => {
        result.current.setConversationMessages(messages);
      });

      expect(result.current.conversationMessages).toEqual(messages);
    });

    it('should replace existing messages', () => {
      const { result } = renderHook(() => useAgentStore());

      const initialMessages = [{ id: 'msg-1', role: 'user', content: 'First' }] as never[];
      const newMessages = [{ id: 'msg-2', role: 'user', content: 'Second' }] as never[];

      act(() => {
        result.current.setConversationMessages(initialMessages);
      });

      act(() => {
        result.current.setConversationMessages(newMessages);
      });

      expect(result.current.conversationMessages).toEqual(newMessages);
    });
  });

  // ============================================
  // clearConversation Tests
  // ============================================
  describe('clearConversation', () => {
    it('should clear all conversation state', () => {
      const { result } = renderHook(() => useAgentStore());

      // Set up conversation state
      useAgentStore.setState({
        conversationId: 'conv-123',
        conversationMessages: [{ id: 'msg-1', role: 'user', content: 'Hello' }] as never[],
        conversationAgentId: 'agent-123',
      });

      act(() => {
        result.current.clearConversation();
      });

      expect(result.current.conversationId).toBeNull();
      expect(result.current.conversationMessages).toEqual([]);
      expect(result.current.conversationAgentId).toBeNull();
    });

    it('should preserve agent selection when clearing conversation', () => {
      const { result } = renderHook(() => useAgentStore());

      useAgentStore.setState({
        selectedAgent: mockAgent,
        conversationId: 'conv-123',
        conversationMessages: [{ id: 'msg-1', role: 'user', content: 'Hello' }] as never[],
      });

      act(() => {
        result.current.clearConversation();
      });

      expect(result.current.selectedAgent).toEqual(mockAgent);
      expect(result.current.conversationId).toBeNull();
    });
  });

  // ============================================
  // Type Safety Tests
  // ============================================
  describe('type safety', () => {
    it('should accept valid SidebarTab values', () => {
      const { result } = renderHook(() => useAgentStore());

      const validTabs: SidebarTab[] = ['chat', 'history', 'settings'];

      validTabs.forEach((tab) => {
        act(() => {
          result.current.setActiveTab(tab);
        });
        expect(result.current.activeTab).toBe(tab);
      });
    });

    it('should accept AgentInfo with optional fields', () => {
      const { result } = renderHook(() => useAgentStore());

      const minimalAgent: AgentInfo = {
        id: 'test',
        title: 'Test',
        driveId: 'drive-1',
        driveName: 'Drive',
      };

      act(() => {
        result.current.selectAgent(minimalAgent);
      });

      expect(result.current.selectedAgent).toEqual(minimalAgent);
    });
  });
});

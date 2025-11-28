/**
 * usePageAgentSidebarState Hook Tests
 * Tests for sidebar agent selection, persistence, and conversation management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePageAgentSidebarState, SidebarAgentInfo } from '../usePageAgentSidebarState';

// Mock fetchWithAuth
const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

// Mock toast
vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Storage key constant (must match the one in the hook)
const STORAGE_KEY_AGENT_DATA = 'pagespace:sidebar:selectedAgentData';

describe('usePageAgentSidebarState', () => {
  // Sample agent data
  const mockAgent: SidebarAgentInfo = {
    id: 'agent-123',
    title: 'Test Agent',
    driveId: 'drive-456',
    driveName: 'Test Drive',
    systemPrompt: 'You are a helpful assistant',
    aiProvider: 'openai',
    aiModel: 'gpt-4',
    enabledTools: ['search', 'calendar'],
  };

  const mockAgent2: SidebarAgentInfo = {
    id: 'agent-789',
    title: 'Another Agent',
    driveId: 'drive-456',
    driveName: 'Test Drive',
  };

  beforeEach(() => {
    // Clear localStorage
    localStorage.clear();
    // Reset all mocks
    vi.clearAllMocks();
    // Default mock response for fetch (empty conversations)
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ conversations: [] }),
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ============================================
  // Initial State Tests
  // ============================================
  describe('initial state', () => {
    it('should start with null selectedAgent (global mode)', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should start with null conversationId', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.conversationId).toBeNull();
    });

    it('should start with empty initialMessages', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.initialMessages).toEqual([]);
    });

    it('should start as not initialized', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.isInitialized).toBe(false);
    });
  });

  // ============================================
  // Agent Selection Tests
  // ============================================
  describe('selectAgent', () => {
    it('should select an agent', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        result.current.selectAgent(mockAgent);
      });

      expect(result.current.selectedAgent).toEqual(mockAgent);
    });

    it('should return to global mode when selecting null', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      // First select an agent
      act(() => {
        result.current.selectAgent(mockAgent);
      });
      expect(result.current.selectedAgent).toEqual(mockAgent);

      // Then deselect (return to global)
      act(() => {
        result.current.selectAgent(null);
      });
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should reset conversation state when switching agents', async () => {
      // Mock successful conversation creation
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: async () => ({ conversationId: 'conv-123' }),
      });

      const { result } = renderHook(() => usePageAgentSidebarState());

      // Select first agent
      act(() => {
        result.current.selectAgent(mockAgent);
      });

      // Wait for conversation to be created
      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true);
      });

      // Select different agent
      act(() => {
        result.current.selectAgent(mockAgent2);
      });

      // Should reset initialization
      expect(result.current.isInitialized).toBe(false);
    });
  });

  // ============================================
  // localStorage Persistence Tests
  // ============================================
  describe('localStorage persistence', () => {
    it('should persist selected agent to localStorage', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        result.current.selectAgent(mockAgent);
      });

      const stored = localStorage.getItem(STORAGE_KEY_AGENT_DATA);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!)).toEqual(mockAgent);
    });

    it('should remove from localStorage when deselecting agent', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      // Select agent
      act(() => {
        result.current.selectAgent(mockAgent);
      });
      expect(localStorage.getItem(STORAGE_KEY_AGENT_DATA)).not.toBeNull();

      // Deselect
      act(() => {
        result.current.selectAgent(null);
      });
      expect(localStorage.getItem(STORAGE_KEY_AGENT_DATA)).toBeNull();
    });

    it('should restore agent from localStorage on mount', () => {
      // Pre-populate localStorage
      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify(mockAgent));

      const { result } = renderHook(() => usePageAgentSidebarState());

      // Should restore the agent
      expect(result.current.selectedAgent).toEqual(mockAgent);
    });

    it('should handle invalid localStorage data gracefully', () => {
      // Set invalid JSON
      localStorage.setItem(STORAGE_KEY_AGENT_DATA, 'not valid json');

      const { result } = renderHook(() => usePageAgentSidebarState());

      // Should start with null (invalid data cleaned up)
      expect(result.current.selectedAgent).toBeNull();
      // localStorage should be cleaned up
      expect(localStorage.getItem(STORAGE_KEY_AGENT_DATA)).toBeNull();
    });

    it('should handle incomplete agent data gracefully', () => {
      // Set data missing required fields
      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify({ id: 'test' }));

      const { result } = renderHook(() => usePageAgentSidebarState());

      // Should start with null (incomplete data is invalid)
      expect(result.current.selectedAgent).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY_AGENT_DATA)).toBeNull();
    });
  });

  // ============================================
  // Conversation Loading Tests
  // ============================================
  describe('conversation loading', () => {
    it('should load most recent conversation when selecting agent', async () => {
      const mockMessages = [
        { id: 'msg-1', role: 'user', content: 'Hello' },
        { id: 'msg-2', role: 'assistant', content: 'Hi there!' },
      ];

      // Mock loading existing conversation
      mockFetchWithAuth
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            conversations: [{ id: 'conv-existing' }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ messages: mockMessages }),
        });

      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        result.current.selectAgent(mockAgent);
      });

      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true);
      });

      expect(result.current.conversationId).toBe('conv-existing');
      expect(result.current.initialMessages).toEqual(mockMessages);
    });

    it('should create new conversation if none exists', async () => {
      // Mock no existing conversations, then successful creation
      mockFetchWithAuth
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ conversations: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ conversationId: 'conv-new' }),
        });

      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        result.current.selectAgent(mockAgent);
      });

      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true);
      });

      expect(result.current.conversationId).toBe('conv-new');
      expect(result.current.initialMessages).toEqual([]);
    });

    it('should handle conversation loading errors gracefully', async () => {
      mockFetchWithAuth.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        result.current.selectAgent(mockAgent);
      });

      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true);
      });

      // Should be initialized but without conversation (allows UI to recover)
      // Note: conversationId remains null because no conversation was loaded/created
      expect(result.current.conversationId).toBeFalsy();
    });
  });

  // ============================================
  // createNewConversation Tests
  // ============================================
  describe('createNewConversation', () => {
    it('should create a new conversation for selected agent', async () => {
      mockFetchWithAuth
        // Initial load (empty)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ conversations: [] }),
        })
        // Initial creation
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ conversationId: 'conv-initial' }),
        })
        // New conversation creation
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ conversationId: 'conv-new' }),
        });

      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        result.current.selectAgent(mockAgent);
      });

      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true);
      });

      let newConvId: string | null = null;
      await act(async () => {
        newConvId = await result.current.createNewConversation();
      });

      expect(newConvId).toBe('conv-new');
      expect(result.current.conversationId).toBe('conv-new');
      expect(result.current.initialMessages).toEqual([]);
    });

    it('should return null if no agent is selected', async () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      let newConvId: string | null = null;
      await act(async () => {
        newConvId = await result.current.createNewConversation();
      });

      expect(newConvId).toBeNull();
    });
  });

  // ============================================
  // refreshConversation Tests
  // ============================================
  describe('refreshConversation', () => {
    it('should refresh messages for current conversation', async () => {
      const initialMessages = [{ id: 'msg-1', role: 'user', content: 'Hello' }];
      const updatedMessages = [
        { id: 'msg-1', role: 'user', content: 'Hello' },
        { id: 'msg-2', role: 'assistant', content: 'Hi!' },
      ];

      mockFetchWithAuth
        // Load existing conversation
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ conversations: [{ id: 'conv-123' }] }),
        })
        // Load initial messages
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ messages: initialMessages }),
        })
        // Refresh messages
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ messages: updatedMessages }),
        });

      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        result.current.selectAgent(mockAgent);
      });

      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true);
      });

      expect(result.current.initialMessages).toEqual(initialMessages);

      await act(async () => {
        await result.current.refreshConversation();
      });

      expect(result.current.initialMessages).toEqual(updatedMessages);
    });
  });

  // ============================================
  // updateMessages Tests
  // ============================================
  describe('updateMessages', () => {
    it('should update messages optimistically', async () => {
      mockFetchWithAuth
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ conversations: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ conversationId: 'conv-123' }),
        });

      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        result.current.selectAgent(mockAgent);
      });

      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true);
      });

      const newMessages = [
        { id: 'msg-1', role: 'user', content: 'Test' },
      ] as never[];

      act(() => {
        result.current.updateMessages(newMessages);
      });

      expect(result.current.initialMessages).toEqual(newMessages);
    });
  });

  // ============================================
  // Type Guard Tests
  // ============================================
  describe('type validation', () => {
    it('should validate agent with all required fields', () => {
      const validAgent = {
        id: 'test',
        title: 'Test',
        driveId: 'drive-1',
        driveName: 'Drive',
      };

      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify(validAgent));

      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.selectedAgent).toEqual(validAgent);
    });

    it('should reject agent missing id', () => {
      const invalidAgent = {
        title: 'Test',
        driveId: 'drive-1',
        driveName: 'Drive',
      };

      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify(invalidAgent));

      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should reject agent missing title', () => {
      const invalidAgent = {
        id: 'test',
        driveId: 'drive-1',
        driveName: 'Drive',
      };

      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify(invalidAgent));

      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should reject agent missing driveId', () => {
      const invalidAgent = {
        id: 'test',
        title: 'Test',
        driveName: 'Drive',
      };

      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify(invalidAgent));

      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should reject agent missing driveName', () => {
      const invalidAgent = {
        id: 'test',
        title: 'Test',
        driveId: 'drive-1',
      };

      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify(invalidAgent));

      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should accept agent with optional fields', () => {
      const agentWithOptionals = {
        id: 'test',
        title: 'Test',
        driveId: 'drive-1',
        driveName: 'Drive',
        systemPrompt: 'Custom prompt',
        aiProvider: 'anthropic',
        aiModel: 'claude-3',
        enabledTools: ['tool1', 'tool2'],
      };

      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify(agentWithOptionals));

      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.selectedAgent).toEqual(agentWithOptionals);
    });
  });
});

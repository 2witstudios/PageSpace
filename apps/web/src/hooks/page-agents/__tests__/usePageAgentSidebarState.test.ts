/**
 * usePageAgentSidebarState Hook Tests
 * Tests for sidebar agent selection, persistence, and conversation management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePageAgentSidebarState, SidebarAgentInfo, useSidebarAgentStore } from '../usePageAgentSidebarState';

// Mock fetchWithAuth
const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
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

// Helper to store agent data in the Zustand persist format
function storeAgentInPersistFormat(agent: SidebarAgentInfo | null) {
  if (agent) {
    localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify({ state: { selectedAgent: agent }, version: 0 }));
  } else {
    localStorage.removeItem(STORAGE_KEY_AGENT_DATA);
  }
}

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
    // Reset Zustand store state to initial values
    useSidebarAgentStore.setState({
      selectedAgent: null,
      conversationId: null,
      initialMessages: [],
      isInitialized: false,
      agentIdForConversation: null,
      _loadingAgentId: null,
    });
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
      // Zustand persist wraps state in { state: { ... }, version: 0 } format
      const parsed = JSON.parse(stored!);
      expect(parsed.state.selectedAgent).toEqual(mockAgent);
    });

    it('should remove agent from localStorage when deselecting', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      // Select agent
      act(() => {
        result.current.selectAgent(mockAgent);
      });
      const stored = localStorage.getItem(STORAGE_KEY_AGENT_DATA);
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored!).state.selectedAgent).toEqual(mockAgent);

      // Deselect
      act(() => {
        result.current.selectAgent(null);
      });
      // Zustand persist keeps the key but sets selectedAgent to null
      const storedAfter = localStorage.getItem(STORAGE_KEY_AGENT_DATA);
      expect(storedAfter).not.toBeNull();
      expect(JSON.parse(storedAfter!).state.selectedAgent).toBeNull();
    });

    it('should restore agent from localStorage on mount', async () => {
      // Pre-populate localStorage with correct persist format
      storeAgentInPersistFormat(mockAgent);
      // Force store to rehydrate from localStorage
      await useSidebarAgentStore.persist.rehydrate();

      const { result } = renderHook(() => usePageAgentSidebarState());

      // Should restore the agent
      expect(result.current.selectedAgent).toEqual(mockAgent);
    });

    it('should handle invalid localStorage data gracefully', async () => {
      // Set invalid JSON
      localStorage.setItem(STORAGE_KEY_AGENT_DATA, 'not valid json');
      // Force store to attempt rehydration (should fail gracefully)
      await useSidebarAgentStore.persist.rehydrate();

      const { result } = renderHook(() => usePageAgentSidebarState());

      // Should start with null (invalid data cleaned up)
      expect(result.current.selectedAgent).toBeNull();
      // localStorage should be cleaned up
      expect(localStorage.getItem(STORAGE_KEY_AGENT_DATA)).toBeNull();
    });

    it('should handle incomplete agent data gracefully', async () => {
      // Set data missing required fields (in persist format)
      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify({ state: { selectedAgent: { id: 'test' } }, version: 0 }));
      // Force store to attempt rehydration (should reject invalid data)
      await useSidebarAgentStore.persist.rehydrate();

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
    it('should validate agent with all required fields', async () => {
      const validAgent = {
        id: 'test',
        title: 'Test',
        driveId: 'drive-1',
        driveName: 'Drive',
      };

      storeAgentInPersistFormat(validAgent as SidebarAgentInfo);
      await useSidebarAgentStore.persist.rehydrate();

      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.selectedAgent).toEqual(validAgent);
    });

    it('should reject agent missing id', async () => {
      const invalidAgent = {
        title: 'Test',
        driveId: 'drive-1',
        driveName: 'Drive',
      };

      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify({ state: { selectedAgent: invalidAgent }, version: 0 }));
      await useSidebarAgentStore.persist.rehydrate();

      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should reject agent missing title', async () => {
      const invalidAgent = {
        id: 'test',
        driveId: 'drive-1',
        driveName: 'Drive',
      };

      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify({ state: { selectedAgent: invalidAgent }, version: 0 }));
      await useSidebarAgentStore.persist.rehydrate();

      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should reject agent missing driveId', async () => {
      const invalidAgent = {
        id: 'test',
        title: 'Test',
        driveName: 'Drive',
      };

      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify({ state: { selectedAgent: invalidAgent }, version: 0 }));
      await useSidebarAgentStore.persist.rehydrate();

      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should reject agent missing driveName', async () => {
      const invalidAgent = {
        id: 'test',
        title: 'Test',
        driveId: 'drive-1',
      };

      localStorage.setItem(STORAGE_KEY_AGENT_DATA, JSON.stringify({ state: { selectedAgent: invalidAgent }, version: 0 }));
      await useSidebarAgentStore.persist.rehydrate();

      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should accept agent with optional fields', async () => {
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

      storeAgentInPersistFormat(agentWithOptionals as SidebarAgentInfo);
      await useSidebarAgentStore.persist.rehydrate();

      const { result } = renderHook(() => usePageAgentSidebarState());
      expect(result.current.selectedAgent).toEqual(agentWithOptionals);
    });
  });

  // ============================================
  // transferFromDashboard Tests
  // ============================================
  describe('transferFromDashboard', () => {
    it('should transfer agent state from dashboard store', () => {
      const mockMessages = [
        { id: 'msg-1', role: 'user', content: 'Hello' },
        { id: 'msg-2', role: 'assistant', content: 'Hi!' },
      ] as never[];

      const { result } = renderHook(() => usePageAgentSidebarState());

      // Initially empty
      expect(result.current.selectedAgent).toBeNull();
      expect(result.current.conversationId).toBeNull();
      expect(result.current.initialMessages).toEqual([]);
      expect(result.current.isInitialized).toBe(false);

      // Transfer state from dashboard
      act(() => {
        useSidebarAgentStore.getState().transferFromDashboard({
          agent: mockAgent,
          conversationId: 'conv-from-dashboard',
          messages: mockMessages,
        });
      });

      // Verify state was transferred
      expect(result.current.selectedAgent).toEqual(mockAgent);
      expect(result.current.conversationId).toBe('conv-from-dashboard');
      expect(result.current.initialMessages).toEqual(mockMessages);
      expect(result.current.isInitialized).toBe(true);
    });

    it('should transfer agent with null conversationId', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        useSidebarAgentStore.getState().transferFromDashboard({
          agent: mockAgent,
          conversationId: null,
          messages: [],
        });
      });

      expect(result.current.selectedAgent).toEqual(mockAgent);
      expect(result.current.conversationId).toBeNull();
      expect(result.current.initialMessages).toEqual([]);
      expect(result.current.isInitialized).toBe(true);
    });

    it('should override existing sidebar state when transferring', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      // Set up initial state
      act(() => {
        result.current.selectAgent(mockAgent2);
      });

      // Wait for initialization
      act(() => {
        useSidebarAgentStore.setState({
          conversationId: 'existing-conv',
          initialMessages: [{ id: 'old-msg', role: 'user', content: 'Old' }] as never[],
          isInitialized: true,
          agentIdForConversation: mockAgent2.id,
        });
      });

      // Transfer new state from dashboard
      const newMessages = [{ id: 'new-msg', role: 'user', content: 'New' }] as never[];
      act(() => {
        useSidebarAgentStore.getState().transferFromDashboard({
          agent: mockAgent,
          conversationId: 'dashboard-conv',
          messages: newMessages,
        });
      });

      // Verify state was replaced
      expect(result.current.selectedAgent).toEqual(mockAgent);
      expect(result.current.conversationId).toBe('dashboard-conv');
      expect(result.current.initialMessages).toEqual(newMessages);
    });

    it('should clear loading state when transferring', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      // Simulate loading state
      act(() => {
        useSidebarAgentStore.setState({
          _loadingAgentId: 'some-agent',
          isInitialized: false,
        });
      });

      // Transfer should clear loading
      act(() => {
        useSidebarAgentStore.getState().transferFromDashboard({
          agent: mockAgent,
          conversationId: 'conv-123',
          messages: [],
        });
      });

      // Verify loading state is cleared
      expect(result.current.isInitialized).toBe(true);
      expect(useSidebarAgentStore.getState()._loadingAgentId).toBeNull();
    });

    it('should set correct agentIdForConversation when transferring', () => {
      act(() => {
        useSidebarAgentStore.getState().transferFromDashboard({
          agent: mockAgent,
          conversationId: 'conv-123',
          messages: [],
        });
      });

      expect(useSidebarAgentStore.getState().agentIdForConversation).toBe(mockAgent.id);
    });

    it('should handle empty messages array', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        useSidebarAgentStore.getState().transferFromDashboard({
          agent: mockAgent,
          conversationId: 'conv-123',
          messages: [],
        });
      });

      expect(result.current.initialMessages).toEqual([]);
      expect(result.current.isInitialized).toBe(true);
    });

    it('should transfer large message arrays efficiently', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      // Create a large message array
      const largeMessages = Array.from({ length: 100 }, (_, i) => ({
        id: `msg-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
      })) as never[];

      act(() => {
        useSidebarAgentStore.getState().transferFromDashboard({
          agent: mockAgent,
          conversationId: 'conv-large',
          messages: largeMessages,
        });
      });

      expect(result.current.initialMessages).toHaveLength(100);
      expect(result.current.initialMessages[0]).toEqual(largeMessages[0]);
      expect(result.current.initialMessages[99]).toEqual(largeMessages[99]);
    });
  });
});

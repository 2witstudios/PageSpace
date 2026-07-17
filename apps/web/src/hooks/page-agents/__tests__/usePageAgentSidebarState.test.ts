/**
 * usePageAgentSidebarState Hook Tests
 * Tests for sidebar agent selection, persistence, and conversation management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePageAgentSidebarState, SidebarAgentInfo, useSidebarAgentStore } from '../usePageAgentSidebarState';
// REAL conversation cache: the hook's loaders commit messages there (PR 5B, leaf 5.3).
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';

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
      identity: { status: 'idle' },
      conversationId: null,
      isInitialized: false,
      agentIdForConversation: null,
      _loadingAgentId: null,
    });
    useConversationMessagesStore.setState({ byConversationId: {} });
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
      await waitFor(() => {
        expect(useConversationMessagesStore.getState().getEntry('conv-existing').messages).toEqual(mockMessages);
      });
    });

    it('should create new conversation if none exists', async () => {
      // Mock no existing conversations, then a successful (client-id) persist
      mockFetchWithAuth
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ conversations: [] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({}),
        });

      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        result.current.selectAgent(mockAgent);
      });

      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true);
      });

      // The id is now generated client-side (cuid2), not read from the
      // server response — just verify one was adopted, seeded loaded-empty.
      expect(result.current.conversationId).not.toBeNull();
      const entry = useConversationMessagesStore.getState().getEntry(result.current.conversationId as string);
      expect(entry.messages).toEqual([]);
      expect(entry.loadStatus).toBe('loaded');
    });

    it('should recover from a transient list-fetch error by falling back to a client-generated new conversation', async () => {
      // Only the list-fetch fails; the create persist (fire-and-forget) then
      // hits the default mock and "succeeds" — the id was already generated
      // client-side, so a network blip here no longer strands the user.
      mockFetchWithAuth.mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        result.current.selectAgent(mockAgent);
      });

      await waitFor(() => {
        expect(result.current.isInitialized).toBe(true);
      });

      expect(result.current.conversationId).not.toBeNull();
      expect(useConversationMessagesStore.getState().getEntry(result.current.conversationId as string).messages).toEqual([]);
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
        // Initial creation persist
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({}),
        })
        // New conversation creation persist
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({}),
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

      expect(newConvId).not.toBeNull();
      expect(result.current.conversationId).toBe(newConvId);
      const entry = useConversationMessagesStore.getState().getEntry(newConvId as unknown as string);
      expect(entry.messages).toEqual([]);
      expect(entry.loadStatus).toBe('loaded');
    });

    it('should return null if no agent is selected', async () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      let newConvId: string | null = null;
      await act(async () => {
        newConvId = await result.current.createNewConversation();
      });

      expect(newConvId).toBeNull();
    });

    it('given createNewConversation is called, should set conversationId synchronously — before the persist POST resolves', async () => {
      let resolvePersist!: (value: unknown) => void;
      mockFetchWithAuth.mockImplementation((url: string, opts?: { method?: string }) => {
        if (opts?.method === 'POST') {
          return new Promise((resolve) => { resolvePersist = resolve; });
        }
        return Promise.resolve({ ok: true, json: async () => ({ conversations: [] }) });
      });

      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        result.current.selectAgent(mockAgent);
      });
      await waitFor(() => expect(result.current.isInitialized).toBe(true));

      let createPromise!: Promise<string | null>;
      act(() => {
        createPromise = result.current.createNewConversation();
      });

      // Must be set synchronously, before the persist POST resolves.
      expect(result.current.conversationId).not.toBeNull();
      const issuedId = result.current.conversationId;

      resolvePersist({ ok: true, json: async () => ({}) });
      await act(() => createPromise);
      expect(result.current.conversationId).toBe(issuedId);
    });
  });

  // ============================================
  // loadConversation Tests
  // ============================================
  describe('loadConversation', () => {
    it('given loadConversation is called, should set conversationId synchronously — before its messages fetch resolves', async () => {
      mockFetchWithAuth.mockResolvedValueOnce({ ok: true, json: async () => ({ conversations: [] }) });

      const { result } = renderHook(() => usePageAgentSidebarState());
      act(() => {
        result.current.selectAgent(mockAgent);
      });
      await waitFor(() => expect(result.current.isInitialized).toBe(true));

      let resolveMessages!: (value: unknown) => void;
      mockFetchWithAuth.mockImplementation(
        () => new Promise((resolve) => { resolveMessages = resolve; })
      );

      let loadPromise!: Promise<void>;
      act(() => {
        loadPromise = result.current.loadConversation('picked-from-history');
      });

      // Must be set synchronously, before the messages fetch resolves.
      expect(result.current.conversationId).toBe('picked-from-history');

      resolveMessages({ ok: true, json: async () => ({ messages: [] }) });
      await act(() => loadPromise);
    });

    it('given loadConversation is called, the cache entry should read loading until its messages fetch resolves, and the fetch should carry includeStreaming=1', async () => {
      mockFetchWithAuth.mockResolvedValueOnce({ ok: true, json: async () => ({ conversations: [] }) });

      const { result } = renderHook(() => usePageAgentSidebarState());
      act(() => {
        result.current.selectAgent(mockAgent);
      });
      await waitFor(() => expect(result.current.isInitialized).toBe(true));

      let resolveMessages!: (value: unknown) => void;
      mockFetchWithAuth.mockImplementation(
        () => new Promise((resolve) => { resolveMessages = resolve; })
      );

      let loadPromise!: Promise<void>;
      act(() => {
        loadPromise = result.current.loadConversation('picked-from-history');
      });

      expect(result.current.conversationId).toBe('picked-from-history');
      expect(useConversationMessagesStore.getState().getEntry('picked-from-history').loadStatus).toBe('loading');
      // Absorbed E2 D task: agent-mode history rejoin must see the in-flight placeholder.
      const messagesFetchUrl = mockFetchWithAuth.mock.calls[mockFetchWithAuth.mock.calls.length - 1][0] as string;
      expect(messagesFetchUrl).toContain('includeStreaming=1');

      await act(async () => {
        resolveMessages({ ok: true, json: async () => ({ messages: [] }) });
        await loadPromise;
      });

      expect(useConversationMessagesStore.getState().getEntry('picked-from-history').loadStatus).toBe('loaded');
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

      await waitFor(() => {
        expect(useConversationMessagesStore.getState().getEntry('conv-123').messages).toEqual(initialMessages);
      });

      await act(async () => {
        await result.current.refreshConversation();
      });

      expect(useConversationMessagesStore.getState().getEntry('conv-123').messages).toEqual(updatedMessages);
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
    it('should transfer agent selection + conversation identity from dashboard store (agent + conversationId ONLY — the cache already holds the messages)', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      expect(result.current.selectedAgent).toBeNull();
      expect(result.current.conversationId).toBeNull();
      expect(result.current.isInitialized).toBe(false);

      act(() => {
        useSidebarAgentStore.getState().transferFromDashboard({
          agent: mockAgent,
          conversationId: 'conv-from-dashboard',
        });
      });

      expect(result.current.selectedAgent).toEqual(mockAgent);
      expect(result.current.conversationId).toBe('conv-from-dashboard');
      expect(result.current.isInitialized).toBe(true);
    });

    it('should transfer agent with null conversationId', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        useSidebarAgentStore.getState().transferFromDashboard({
          agent: mockAgent,
          conversationId: null,
        });
      });

      expect(result.current.selectedAgent).toEqual(mockAgent);
      expect(result.current.conversationId).toBeNull();
      expect(result.current.isInitialized).toBe(true);
    });

    it('should override existing sidebar state when transferring', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        result.current.selectAgent(mockAgent2);
      });
      act(() => {
        useSidebarAgentStore.setState({
          conversationId: 'existing-conv',
          isInitialized: true,
          agentIdForConversation: mockAgent2.id,
        });
      });

      act(() => {
        useSidebarAgentStore.getState().transferFromDashboard({
          agent: mockAgent,
          conversationId: 'dashboard-conv',
        });
      });

      expect(result.current.selectedAgent).toEqual(mockAgent);
      expect(result.current.conversationId).toBe('dashboard-conv');
    });

    it('should clear loading state when transferring', () => {
      const { result } = renderHook(() => usePageAgentSidebarState());

      act(() => {
        useSidebarAgentStore.setState({
          _loadingAgentId: 'some-agent',
          isInitialized: false,
        });
      });

      act(() => {
        useSidebarAgentStore.getState().transferFromDashboard({
          agent: mockAgent,
          conversationId: 'conv-123',
        });
      });

      expect(result.current.isInitialized).toBe(true);
      expect(useSidebarAgentStore.getState()._loadingAgentId).toBeNull();
    });

    it('should set correct agentIdForConversation when transferring', () => {
      act(() => {
        useSidebarAgentStore.getState().transferFromDashboard({
          agent: mockAgent,
          conversationId: 'conv-123',
        });
      });

      expect(useSidebarAgentStore.getState().agentIdForConversation).toBe(mockAgent.id);
    });
  });
});

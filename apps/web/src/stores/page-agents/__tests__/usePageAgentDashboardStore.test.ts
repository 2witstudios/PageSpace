/**
 * usePageAgentDashboardStore Tests
 * Tests for centralized agent state management (dashboard context)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePageAgentDashboardStore, type AgentInfo, type SidebarTab } from '../usePageAgentDashboardStore';

// Mock fetchWithAuth
const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

// Mock conversationState
vi.mock('@/lib/ai/core/conversation-state', () => ({
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

describe('usePageAgentDashboardStore', () => {
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
    usePageAgentDashboardStore.setState({
      selectedAgent: null,
      isInitialized: false,
      identity: { status: 'idle' },
      conversationId: null,
      conversationMessages: [],
      isConversationLoading: false,
      isConversationMessagesLoading: false,
      conversationAgentId: null,
      conversationLoadSignal: 0,
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
      const { result } = renderHook(() => usePageAgentDashboardStore());
      expect(result.current.selectedAgent).toBeNull();
    });

    it('should not be initialized', () => {
      const { result } = renderHook(() => usePageAgentDashboardStore());
      expect(result.current.isInitialized).toBe(false);
    });

    it('should have history as default activeTab', () => {
      const { result } = renderHook(() => usePageAgentDashboardStore());
      expect(result.current.activeTab).toBe('history');
    });

    it('should have null conversationId', () => {
      const { result } = renderHook(() => usePageAgentDashboardStore());
      expect(result.current.conversationId).toBeNull();
    });

    it('should have empty conversationMessages', () => {
      const { result } = renderHook(() => usePageAgentDashboardStore());
      expect(result.current.conversationMessages).toEqual([]);
    });
  });

  // ============================================
  // setActiveTab Tests
  // ============================================
  describe('setActiveTab', () => {
    it('should update activeTab to history', () => {
      const { result } = renderHook(() => usePageAgentDashboardStore());

      act(() => {
        result.current.setActiveTab('history');
      });

      expect(result.current.activeTab).toBe('history');
    });

    it('should update activeTab to activity', () => {
      const { result } = renderHook(() => usePageAgentDashboardStore());

      act(() => {
        result.current.setActiveTab('activity');
      });

      expect(result.current.activeTab).toBe('activity');
    });

    it('should update activeTab to chat', () => {
      const { result } = renderHook(() => usePageAgentDashboardStore());

      act(() => {
        result.current.setActiveTab('chat');
      });

      expect(result.current.activeTab).toBe('chat');
    });

    it('should preserve other state when changing tabs', () => {
      const { result } = renderHook(() => usePageAgentDashboardStore());

      // Set up some state
      act(() => {
        result.current.selectAgent(mockAgent);
      });

      const agentBefore = result.current.selectedAgent;

      act(() => {
        result.current.setActiveTab('activity');
      });

      expect(result.current.selectedAgent).toEqual(agentBefore);
      expect(result.current.activeTab).toBe('activity');
    });
  });

  // ============================================
  // selectAgent Tests
  // ============================================
  describe('selectAgent', () => {
    it('should select an agent', () => {
      const { result } = renderHook(() => usePageAgentDashboardStore());

      act(() => {
        result.current.selectAgent(mockAgent);
      });

      expect(result.current.selectedAgent).toEqual(mockAgent);
    });

    it('should deselect agent when passing null', () => {
      const { result } = renderHook(() => usePageAgentDashboardStore());

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
      const { result } = renderHook(() => usePageAgentDashboardStore());

      // Set up initial agent with conversation
      usePageAgentDashboardStore.setState({
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
      const { result } = renderHook(() => usePageAgentDashboardStore());

      // Set up initial agent with conversation
      usePageAgentDashboardStore.setState({
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
      const { result } = renderHook(() => usePageAgentDashboardStore());

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
      const { result } = renderHook(() => usePageAgentDashboardStore());

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
      const { result } = renderHook(() => usePageAgentDashboardStore());

      // Set up conversation state
      usePageAgentDashboardStore.setState({
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
      const { result } = renderHook(() => usePageAgentDashboardStore());

      usePageAgentDashboardStore.setState({
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
  // createNewConversation Tests
  // ============================================
  describe('createNewConversation', () => {
    it('given an agent is selected, should set conversationId synchronously with a client-generated id before the create request resolves', async () => {
      let resolveFetch!: (value: unknown) => void;
      mockFetchWithAuth.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

      usePageAgentDashboardStore.setState({ selectedAgent: mockAgent });
      const { result } = renderHook(() => usePageAgentDashboardStore());

      let createPromise!: Promise<string | null>;
      act(() => {
        createPromise = result.current.createNewConversation();
      });

      // Identity must be set before the network request resolves.
      const generatedId = result.current.conversationId;
      expect(typeof generatedId).toBe('string');
      expect(generatedId).not.toBeNull();
      expect(result.current.conversationAgentId).toBe(mockAgent.id);

      resolveFetch({ ok: true, json: async () => ({ conversationId: generatedId }) });
      const resolvedId = await act(() => createPromise);
      expect(resolvedId).toBe(generatedId);
    });

    it('given no agent is selected, should return null and not touch conversation state', async () => {
      usePageAgentDashboardStore.setState({ selectedAgent: null });
      const { result } = renderHook(() => usePageAgentDashboardStore());

      let createPromise!: Promise<string | null>;
      act(() => {
        createPromise = result.current.createNewConversation();
      });

      const resolvedId = await act(() => createPromise);
      expect(resolvedId).toBeNull();
      expect(result.current.conversationId).toBeNull();
    });

    it('given the create request ultimately fails, should not retract the already-issued conversationId', async () => {
      mockFetchWithAuth.mockResolvedValue({ ok: false });
      usePageAgentDashboardStore.setState({ selectedAgent: mockAgent });
      const { result } = renderHook(() => usePageAgentDashboardStore());

      let createPromise!: Promise<string | null>;
      act(() => {
        createPromise = result.current.createNewConversation();
      });
      const issuedId = result.current.conversationId;

      await act(() => createPromise);
      expect(result.current.conversationId).toBe(issuedId);
    });
  });

  // ============================================
  // loadMostRecentConversation -> createNewConversation fallback
  // ============================================
  describe('loadMostRecentConversation falling back to createNewConversation', () => {
    it('given the agent has no existing conversations, should not leave isConversationLoading stuck true', async () => {
      // First fetch (fetchMostRecentAgentConversation) resolves with no conversations;
      // second fetch (the create POST) resolves ok.
      mockFetchWithAuth
        .mockResolvedValueOnce({ ok: true, json: async () => ({ conversations: [] }) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ conversationId: 'new-conv' }) });

      usePageAgentDashboardStore.setState({ selectedAgent: mockAgent });
      const { result } = renderHook(() => usePageAgentDashboardStore());

      await act(() => result.current.loadMostRecentConversation());

      expect(result.current.isConversationLoading).toBe(false);
      expect(result.current.conversationId).not.toBeNull();
    });
  });

  // ============================================
  // Conversation identity race guards
  // ============================================
  describe('conversation identity race guards', () => {
    it('given loadConversation is called, should set conversationId synchronously — before its own messages fetch resolves', async () => {
      let resolveFetch!: (value: unknown) => void;
      mockFetchWithAuth.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));

      usePageAgentDashboardStore.setState({ selectedAgent: mockAgent });
      const { result } = renderHook(() => usePageAgentDashboardStore());

      let loadPromise!: Promise<void>;
      act(() => {
        loadPromise = result.current.loadConversation('picked-from-history');
      });

      expect(result.current.conversationId).toBe('picked-from-history');

      resolveFetch({ ok: true, json: async () => ({ messages: [] }) });
      await act(() => loadPromise);
    });

    it('given loadConversation is called, should set isConversationMessagesLoading true until its messages fetch resolves', async () => {
      let resolveFetch!: (value: unknown) => void;
      mockFetchWithAuth.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));

      usePageAgentDashboardStore.setState({ selectedAgent: mockAgent });
      const { result } = renderHook(() => usePageAgentDashboardStore());

      let loadPromise!: Promise<void>;
      act(() => {
        loadPromise = result.current.loadConversation('picked-from-history');
      });

      // Identity is already 'ready' (ungates sends), but messages are still loading.
      expect(result.current.conversationId).toBe('picked-from-history');
      expect(result.current.isConversationMessagesLoading).toBe(true);

      await act(async () => {
        resolveFetch({ ok: true, json: async () => ({ messages: [] }) });
        await loadPromise;
      });

      expect(result.current.isConversationMessagesLoading).toBe(false);
    });

    it('given loadConversation\'s messages fetch fails, should still clear isConversationMessagesLoading', async () => {
      mockFetchWithAuth.mockRejectedValue(new Error('network down'));

      usePageAgentDashboardStore.setState({ selectedAgent: mockAgent });
      const { result } = renderHook(() => usePageAgentDashboardStore());

      await act(() => result.current.loadConversation('picked-from-history'));

      expect(result.current.isConversationMessagesLoading).toBe(false);
    });

    it('given createNewConversation is called while a prior loadConversation fetch is still in-flight, should clear isConversationMessagesLoading so the new conversation does not show a stuck spinner', async () => {
      let resolveStaleFetch!: (value: unknown) => void;
      mockFetchWithAuth.mockImplementation((url: string) => {
        if (url.includes('/conversations') && !url.includes('limit=50')) {
          return Promise.resolve({ ok: true, json: async () => ({ id: 'server-conv-id' }) });
        }
        return new Promise((resolve) => { resolveStaleFetch = resolve; });
      });

      usePageAgentDashboardStore.setState({ selectedAgent: mockAgent });
      const { result } = renderHook(() => usePageAgentDashboardStore());

      act(() => {
        void result.current.loadConversation('stale-conv');
      });
      expect(result.current.isConversationMessagesLoading).toBe(true);

      await act(() => result.current.createNewConversation());

      expect(result.current.isConversationMessagesLoading).toBe(false);

      // The stale loadConversation fetch resolving afterward must not flip it back on.
      await act(async () => {
        resolveStaleFetch({ ok: true, json: async () => ({ messages: [] }) });
        await Promise.resolve();
      });
      expect(result.current.isConversationMessagesLoading).toBe(false);
    });

    it('given loadMostRecentConversation resolves AFTER createNewConversation already set a newer identity, should not clobber the newer conversationId', async () => {
      let resolveMostRecentList!: (value: unknown) => void;
      mockFetchWithAuth.mockImplementation((url: string) => {
        if (url.includes('limit=1')) {
          return new Promise((resolve) => { resolveMostRecentList = resolve; });
        }
        // The stale conversation's message fetch, and createNewConversation's
        // persist POST, both resolve immediately — only the list lookup is delayed.
        return Promise.resolve({ ok: true, json: async () => ({ messages: [] }) });
      });

      usePageAgentDashboardStore.setState({ selectedAgent: mockAgent });
      const { result } = renderHook(() => usePageAgentDashboardStore());

      let loadMostRecentPromise!: Promise<void>;
      act(() => {
        loadMostRecentPromise = result.current.loadMostRecentConversation();
      });

      // User creates a new conversation while loadMostRecentConversation is still in flight.
      let newId!: string | null;
      await act(async () => {
        newId = await result.current.createNewConversation();
      });
      expect(result.current.conversationId).toBe(newId);

      // The stale loadMostRecentConversation fetch now resolves with a DIFFERENT,
      // older conversation — it must not overwrite the just-created one.
      await act(async () => {
        resolveMostRecentList({ ok: true, json: async () => ({ conversations: [{ id: 'stale-old-conv' }] }) });
        await loadMostRecentPromise;
      });

      expect(result.current.conversationId).toBe(newId);
      expect(result.current.conversationMessages).toEqual([]);
    });

    it('given loadMostRecentConversation applies messages, should drop them if the user switched conversation before the fetch resolved', async () => {
      let resolveMostRecentList!: (value: unknown) => void;
      let resolveMostRecentMessages!: (value: unknown) => void;
      mockFetchWithAuth.mockImplementation((url: string) => {
        if (url.includes('limit=1')) {
          return new Promise((resolve) => { resolveMostRecentList = resolve; });
        }
        if (url.includes('stale-most-recent')) {
          return new Promise((resolve) => { resolveMostRecentMessages = resolve; });
        }
        // loadConversation's own messages fetch (for the user's picked conversation).
        return Promise.resolve({ ok: true, json: async () => ({ messages: [] }) });
      });

      usePageAgentDashboardStore.setState({ selectedAgent: mockAgent });
      const { result } = renderHook(() => usePageAgentDashboardStore());

      let loadMostRecentPromise!: Promise<void>;
      act(() => {
        loadMostRecentPromise = result.current.loadMostRecentConversation();
      });

      await act(async () => {
        resolveMostRecentList({ ok: true, json: async () => ({ conversations: [{ id: 'stale-most-recent' }] }) });
        // Let the list-fetch .then chain run so the messages fetch is issued
        // (and resolveMostRecentMessages captured) before the user switches away.
        await Promise.resolve();
        await Promise.resolve();
      });

      act(() => {
        result.current.loadConversation('user-picked-conv');
      });
      expect(result.current.conversationId).toBe('user-picked-conv');

      await act(async () => {
        resolveMostRecentMessages({ ok: true, json: async () => ({ messages: [{ id: 'stale-msg' }] }) });
        await loadMostRecentPromise;
      });

      expect(result.current.conversationId).toBe('user-picked-conv');
      expect(result.current.conversationMessages).toEqual([]);
    });

    it('given loadMostRecentConversation fails AFTER a newer identity already won, should NOT fall back to creating a new conversation', async () => {
      let rejectMostRecentList!: (err: unknown) => void;
      mockFetchWithAuth.mockImplementation((url: string) => {
        if (url.includes('limit=1')) {
          return new Promise((_resolve, reject) => { rejectMostRecentList = reject; });
        }
        return Promise.resolve({ ok: true, json: async () => ({ messages: [] }) });
      });

      usePageAgentDashboardStore.setState({ selectedAgent: mockAgent });
      const { result } = renderHook(() => usePageAgentDashboardStore());

      let loadMostRecentPromise!: Promise<void>;
      act(() => {
        loadMostRecentPromise = result.current.loadMostRecentConversation();
      });

      // User picks an existing conversation while the failing fetch is still in flight.
      let newId!: string | null;
      await act(async () => {
        newId = await result.current.createNewConversation();
      });
      expect(result.current.conversationId).toBe(newId);

      // The stale loadMostRecentConversation fetch now rejects — its catch
      // block must not fall back to creating yet another conversation on top
      // of the one the user already switched to.
      await act(async () => {
        rejectMostRecentList(new Error('network down'));
        await loadMostRecentPromise;
      });

      expect(result.current.conversationId).toBe(newId);
    });

    it('given loadMostRecentConversation finds no conversation AFTER a newer identity already won, should NOT fall back to creating a new conversation', async () => {
      let resolveMostRecentList!: (value: unknown) => void;
      mockFetchWithAuth.mockImplementation((url: string) => {
        if (url.includes('limit=1')) {
          return new Promise((resolve) => { resolveMostRecentList = resolve; });
        }
        return Promise.resolve({ ok: true, json: async () => ({ messages: [] }) });
      });

      usePageAgentDashboardStore.setState({ selectedAgent: mockAgent });
      const { result } = renderHook(() => usePageAgentDashboardStore());

      let loadMostRecentPromise!: Promise<void>;
      act(() => {
        loadMostRecentPromise = result.current.loadMostRecentConversation();
      });

      let newId!: string | null;
      await act(async () => {
        newId = await result.current.createNewConversation();
      });
      expect(result.current.conversationId).toBe(newId);

      // The stale fetch resolves with an empty list — must not clobber the
      // conversation the user already switched to in the meantime.
      await act(async () => {
        resolveMostRecentList({ ok: true, json: async () => ({ conversations: [] }) });
        await loadMostRecentPromise;
      });

      expect(result.current.conversationId).toBe(newId);
    });

    it('given a stale RESOLVED dispatch is a guaranteed no-op (a newer identity already won), should not write to the store at all', async () => {
      let resolveMostRecentList!: (value: unknown) => void;
      mockFetchWithAuth.mockImplementation((url: string) => {
        if (url.includes('limit=1')) {
          return new Promise((resolve) => { resolveMostRecentList = resolve; });
        }
        // The stale conversation's message fetch, and createNewConversation's
        // persist POST, both resolve immediately.
        return Promise.resolve({ ok: true, json: async () => ({ messages: [] }) });
      });

      usePageAgentDashboardStore.setState({ selectedAgent: mockAgent });
      const { result } = renderHook(() => usePageAgentDashboardStore());

      let loadMostRecentPromise!: Promise<void>;
      act(() => {
        loadMostRecentPromise = result.current.loadMostRecentConversation();
      });
      await act(async () => {
        await result.current.createNewConversation();
      });

      const notify = vi.fn();
      const unsubscribe = usePageAgentDashboardStore.subscribe(notify);

      // The stale loadMostRecentConversation fetch now resolves with a
      // DIFFERENT, older conversation — applyIdentity's RESOLVED dispatch is
      // a guaranteed no-op per the reducer (identity already moved to
      // 'ready' via IDENTITY_SET), so this must not write to the store —
      // not even to re-set the same identity fields.
      await act(async () => {
        resolveMostRecentList({ ok: true, json: async () => ({ conversations: [{ id: 'stale-old-conv' }] }) });
        await loadMostRecentPromise;
      });

      unsubscribe();
      expect(notify).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // Type Safety Tests
  // ============================================
  describe('type safety', () => {
    it('should accept valid SidebarTab values', () => {
      const { result } = renderHook(() => usePageAgentDashboardStore());

      const validTabs: SidebarTab[] = ['chat', 'history', 'activity'];

      validTabs.forEach((tab) => {
        act(() => {
          result.current.setActiveTab(tab);
        });
        expect(result.current.activeTab).toBe(tab);
      });
    });

    it('should accept AgentInfo with optional fields', () => {
      const { result } = renderHook(() => usePageAgentDashboardStore());

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

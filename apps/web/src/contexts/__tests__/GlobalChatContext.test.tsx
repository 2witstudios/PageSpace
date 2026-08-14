import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import React from 'react';

// --- Mocks (hoisted so vi.mock factories can reference them) ---

const SESSION_ID_LOCAL = 'session-current';
const SESSION_ID_REMOTE = 'session-other';

// In-memory pending-streams store used to back onStreamComplete lookups.
// Tests can push/remove entries to simulate the store state.
const mockStreams = new Map<string, {
  messageId: string;
  conversationId: string;
  isOwn: boolean;
  pageId: string;
  triggeredBy: { userId: string; displayName: string };
  parts: [];
}>();

const {
  mockUseSocketStore,
  mockSocket,
  mockUseAuth,
  mockAddStream,
  mockAppendPart,
  mockSetStreamParts,
  mockRemoveStream,
  mockClearPageStreams,
  mockConsumeStreamJoin,
  mockAbortActiveStreamByMessageId,
  mockClearActiveStreamId,
  mockGetBrowserSessionId,
} = vi.hoisted(() => {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const socket = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (handlers[event]) {
        handlers[event] = handlers[event].filter((h) => h !== handler);
      }
    }),
    emit: vi.fn(),
    _trigger: (event: string, payload: unknown) => {
      handlers[event]?.slice().forEach((h) => h(payload));
    },
    _reset: () => {
      Object.keys(handlers).forEach((k) => { handlers[k] = []; });
    },
    _handlerCount: (event: string) => handlers[event]?.length ?? 0,
  };

  return {
    mockUseSocketStore: vi.fn(),
    mockSocket: socket,
    mockUseAuth: vi.fn(),
    mockAddStream: vi.fn(),
    mockAppendPart: vi.fn(),
    mockSetStreamParts: vi.fn(),
    mockRemoveStream: vi.fn(),
    mockClearPageStreams: vi.fn(),
    mockConsumeStreamJoin: vi.fn().mockResolvedValue({ aborted: false }),
    mockAbortActiveStreamByMessageId: vi.fn().mockResolvedValue({ aborted: true, reason: '' }),
    mockClearActiveStreamId: vi.fn(),
    mockGetBrowserSessionId: vi.fn(() => SESSION_ID_LOCAL),
  };
});

vi.mock('@/stores/useSocketStore', () => ({
  useSocketStore: mockUseSocketStore,
}));

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => mockSocket,
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}));

// Shaped like the REAL store: a callable hook that takes a selector, WITH a `getState` on it.
// It used to be a bare `{ getState }` object, which was enough only while every consumer reached
// in imperatively. `DerivedStreamingRegistrations` (rendered by the provider) subscribes to it as
// a hook, so the stand-in has to actually be one — a mock that cannot do what the real module does
// is a mock that hides breakage rather than catching it.
//
// Built inside the factory: vi.mock is hoisted above every top-level const.
// The socket hook reads the signed-in user from the STORE at EVENT time (not from `useAuth`
// at effect time), so that a value captured before auth hydrates cannot classify the user's
// own stream as a stranger's for the life of the subscription.
vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: Object.assign(
    (selector?: (s: { user: { id: string } | null }) => unknown) =>
      selector ? selector({ user: { id: USER_ID } }) : { user: { id: USER_ID } },
    { getState: () => ({ user: { id: USER_ID } }) },
  ),
}));

vi.mock('@/stores/usePendingStreamsStore', () => {
  const state = () => ({
    streams: mockStreams,
    addStream: mockAddStream,
    appendPart: mockAppendPart,
    setStreamParts: mockSetStreamParts,
    removeStream: mockRemoveStream,
    clearPageStreams: mockClearPageStreams,
    getRemotePageStreams: (pageId: string) =>
      Array.from(mockStreams.values()).filter((s) => s.pageId === pageId),
    getOwnStreams: (pageId: string) =>
      Array.from(mockStreams.values()).filter((s) => s.pageId === pageId && s.isOwn),
  });
  const hook = (selector?: (s: ReturnType<typeof state>) => unknown) =>
    selector ? selector(state()) : state();
  hook.getState = state;
  return { usePendingStreamsStore: hook };
});

vi.mock('@/lib/ai/core/stream-join-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/core/stream-join-client')>()),
  consumeStreamJoin: mockConsumeStreamJoin,
}));

vi.mock('@/lib/ai/core/stream-abort-client', () => ({
  abortActiveStreamByMessageId: mockAbortActiveStreamByMessageId,
  clearActiveStreamId: mockClearActiveStreamId,
}));

vi.mock('@/lib/ai/core/browser-session-id', () => ({
  getBrowserSessionId: mockGetBrowserSessionId,
}));

vi.mock('@/lib/ai/streams/bootstrapConsumerGuard', () => ({
  claimBootstrapConsumer: vi.fn(() => true),
  releaseBootstrapConsumer: vi.fn(),
}));

const mockFetchWithAuth = vi.fn();
vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => mockFetchWithAuth(...args),
}));

vi.mock('@/lib/ai/core/conversation-state', () => ({
  conversationState: {
    getActiveConversationId: vi.fn().mockReturnValue(null),
    getActiveAgentId: vi.fn().mockReturnValue(null),
    setActiveConversationId: vi.fn(),
    createAndSetActiveConversation: vi.fn(),
  },
}));

vi.mock('@/lib/url-state', () => ({
  getConversationId: vi.fn().mockReturnValue(null),
  getAgentId: vi.fn().mockReturnValue(null),
  setConversationId: vi.fn(),
}));

vi.mock('@/lib/ai/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/shared')>()),
  useStreamingRegistration: vi.fn(),
}));

import { GlobalChatProvider, useGlobalChatConversation } from '../GlobalChatContext';
import { useStreamingRegistration } from '@/lib/ai/shared';
// REAL conversation cache (PR 5B): loads and remote events commit here, and what
// lands in the cache is the behavior under test — refreshSignal is gone.
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';

// --- Helpers ---

const CONV_ID = 'conv-1';
const USER_ID = 'u1';
const GLOBAL_CHANNEL_ID = `user:${USER_ID}:global`;

const okResponse = (data: unknown) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve(data) });

const defaultFetch = (url: string) => {
  if (url === '/api/ai/global/active') return okResponse({ id: CONV_ID });
  if (url.includes('/api/ai/chat/active-streams')) return okResponse({ streams: [] });
  if (url.includes('/messages')) return okResponse([]);
  return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
};

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <GlobalChatProvider>{children}</GlobalChatProvider>
);

/** Count DB message loads issued for a conversation — the observable behind every
 *  "signal surfaces to re-fetch" assertion, now that producers reload the cache. */
const messagesFetchCount = (conversationId: string) =>
  mockFetchWithAuth.mock.calls.filter(
    ([url]) => url === `/api/ai/global/${conversationId}/messages?limit=50&includeStreaming=1`,
  ).length;

const cacheEntry = (conversationId: string) =>
  useConversationMessagesStore.getState().getEntry(conversationId);

// --- Tests ---

describe('GlobalChatProvider — socket reconnect refresh', () => {
  let mockConnectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';

  beforeEach(() => {
    mockConnectionStatus = 'disconnected';
    vi.clearAllMocks();
    mockSocket._reset();
    mockStreams.clear();
    // Module state — a real reload clears it; a test file must too.
    useConversationMessagesStore.setState({ byConversationId: {} });
    mockUseSocketStore.mockImplementation((selector: (s: { connectionStatus: string }) => unknown) =>
      selector({ connectionStatus: mockConnectionStatus })
    );
    mockFetchWithAuth.mockImplementation(defaultFetch);
    mockUseAuth.mockReturnValue({ user: { id: USER_ID }, isAuthenticated: true });
    mockGetBrowserSessionId.mockReturnValue(SESSION_ID_LOCAL);
    mockConsumeStreamJoin.mockResolvedValue({ aborted: false });
  });

  const renderProvider = () =>
    renderHook(() => useGlobalChatConversation(), { wrapper: Wrapper });

  const setStatus = (
    status: 'disconnected' | 'connecting' | 'connected' | 'error',
    rerender: () => void
  ) => {
    act(() => {
      mockConnectionStatus = status;
      mockUseSocketStore.mockImplementation((selector: (s: { connectionStatus: string }) => unknown) =>
        selector({ connectionStatus: status })
      );
      rerender();
    });
  };

  it('given isInitialized=true and currentConversationId set, when socket reconnects (second connect), should reload the conversation cache exactly once', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    // First connect — sets the hasInitialConnect ref, no refresh
    setStatus('connected', rerender);

    const loadsAfterFirstConnect = messagesFetchCount(CONV_ID);

    // Disconnect then reconnect
    setStatus('disconnected', rerender);
    setStatus('connected', rerender);

    await waitFor(() => {
      expect(messagesFetchCount(CONV_ID)).toBe(loadsAfterFirstConnect + 1);
    });
  });

  it('given socket fires connected for the first time (initial load), should NOT reload the conversation cache', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    const loadsBefore = messagesFetchCount(CONV_ID);

    // First connect
    setStatus('connected', rerender);

    // Allow any potential cascading effects to settle
    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    expect(messagesFetchCount(CONV_ID)).toBe(loadsBefore);
  });

  // NOTE: React testing-library's act() collapses isInitialized false→true into one render,
  // masking the production loop in isolation. This test validates the no-cascade invariant.
  // Two fixes in GlobalChatContext guard against the loop: prevConnectionStatusRef (prevents
  // the effect re-firing when status hasn't changed) and isInitializedRef (prevents isInitialized
  // from being a reactive dep that re-triggers the effect after each refresh).
  it('given refresh completes after reconnect, should NOT trigger a second refresh (no cascade)', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    // First connect — sets hasInitialConnectRef, no refresh
    setStatus('connected', rerender);
    setStatus('disconnected', rerender);

    const loadsBeforeReconnect = messagesFetchCount(CONV_ID);

    // Reconnect — triggers exactly one cache reload
    setStatus('connected', rerender);

    await waitFor(() => {
      expect(messagesFetchCount(CONV_ID)).toBe(loadsBeforeReconnect + 1);
    });

    // Allow any cascade effects to settle — still exactly one
    await waitFor(() =>
      expect(messagesFetchCount(CONV_ID)).toBe(loadsBeforeReconnect + 1)
    );
  });

  it('given socket is already connected when currentConversationId changes (conversation switch), should NOT trigger a spurious refresh', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    // Initial connect — sets hasInitialConnectRef, no refresh
    setStatus('connected', rerender);

    const CONV_ID_2 = 'conv-2';
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === `/api/ai/global/${CONV_ID_2}/messages?limit=50&includeStreaming=1`) return okResponse([]);
      return defaultFetch(url);
    });

    const conv1LoadsBefore = messagesFetchCount(CONV_ID);

    // Switch conversation while connected — should NOT trigger a reconnect-style reload
    act(() => { result.current.loadConversation(CONV_ID_2); });

    // Wait for the load to complete
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID_2));

    // The switch loads conv-2 once; conv-1 must not have been spuriously reloaded
    expect(messagesFetchCount(CONV_ID)).toBe(conv1LoadsBefore);
    expect(messagesFetchCount(CONV_ID_2)).toBe(1);
  });

  it('given isInitialized=false when reconnect fires, should NOT reload anything', async () => {
    // Hang initialization so isInitialized stays false
    mockFetchWithAuth.mockImplementation(() => new Promise(() => {}));

    const { result, rerender } = renderProvider();

    expect(result.current.isInitialized).toBe(false);

    const loadsBefore = messagesFetchCount(CONV_ID);

    // First connect — sets hasInitialConnectRef to true
    setStatus('connected', rerender);
    setStatus('disconnected', rerender);
    // Second connect — isInitialized still false, should not reload
    setStatus('connected', rerender);

    await waitFor(() => {
      expect(messagesFetchCount(CONV_ID)).toBe(loadsBefore);
    });
  });
});

describe('GlobalChatProvider — conversation identity race guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket._reset();
    mockStreams.clear();
    // Module state — a real reload clears it; a test file must too.
    useConversationMessagesStore.setState({ byConversationId: {} });
    mockUseSocketStore.mockImplementation((selector: (s: { connectionStatus: string }) => unknown) =>
      selector({ connectionStatus: 'disconnected' })
    );
    mockUseAuth.mockReturnValue({ user: { id: USER_ID }, isAuthenticated: true });
    mockGetBrowserSessionId.mockReturnValue(SESSION_ID_LOCAL);
    mockConsumeStreamJoin.mockResolvedValue({ aborted: false });
  });

  const renderProvider = () =>
    renderHook(() => useGlobalChatConversation(), { wrapper: Wrapper });

  it('given loadConversation is called for a new id while a stale in-flight load is still pending, should not let the stale messages clobber it', async () => {
    let resolveStaleMessages!: (value: unknown) => void;
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === '/api/ai/global/active') return okResponse({ id: CONV_ID });
      if (url === `/api/ai/global/${CONV_ID}/messages?limit=50&includeStreaming=1`) {
        return new Promise((resolve) => { resolveStaleMessages = resolve; });
      }
      if (url === '/api/ai/global/conv-2/messages?limit=50&includeStreaming=1') {
        return okResponse({ messages: [{ id: 'fresh-msg' }] });
      }
      return okResponse({});
    });

    const { result } = renderProvider();

    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    // Init's own load is still awaiting messages (resolveStaleMessages not yet
    // called) when the user switches to a different conversation.
    await act(async () => {
      await result.current.loadConversation('conv-2');
    });
    expect(result.current.currentConversationId).toBe('conv-2');
    expect(cacheEntry('conv-2').messages).toEqual([{ id: 'fresh-msg' }]);

    // The stale init-triggered fetch for CONV_ID now resolves — the cache is
    // conversation-keyed, so it commits under ITS OWN id and can never overwrite
    // conv-2's identity or entry.
    await act(async () => {
      resolveStaleMessages(okResponse({ messages: [{ id: 'stale-msg' }] }));
      await Promise.resolve();
    });

    expect(result.current.currentConversationId).toBe('conv-2');
    expect(cacheEntry('conv-2').messages).toEqual([{ id: 'fresh-msg' }]);
    expect(cacheEntry(CONV_ID).messages).toEqual([{ id: 'stale-msg' }]);
  });

  it('given createNewConversation is called while init is still resolving, should adopt the new id synchronously', async () => {
    mockFetchWithAuth.mockImplementation(() => new Promise(() => {})); // init hangs forever

    const { conversationState } = await import('@/lib/ai/core/conversation-state');
    vi.mocked(conversationState.createAndSetActiveConversation).mockResolvedValue({
      id: 'brand-new-conv',
      type: 'global',
      title: null,
      lastMessageAt: null,
      createdAt: new Date().toISOString(),
    });

    const { result } = renderProvider();

    expect(result.current.currentConversationId).toBeNull();

    await act(async () => {
      await result.current.createNewConversation();
    });

    expect(result.current.currentConversationId).toBe('brand-new-conv');
    // Seeded loaded-empty in the cache: nothing to fetch for a just-created id.
    expect(cacheEntry('brand-new-conv').loadStatus).toBe('loaded');
    expect(cacheEntry('brand-new-conv').messages).toEqual([]);
  });

  // CR2 (CodeRabbit round 2): the init bootstrap's /active response resolving AFTER
  // the user created a conversation must not overwrite the newer identity.
  it('given the delayed /active bootstrap resolves after createNewConversation already won, should NOT overwrite the newer identity', async () => {
    let resolveActive!: (value: unknown) => void;
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === '/api/ai/global/active') {
        return new Promise((resolve) => { resolveActive = resolve; });
      }
      return defaultFetch(url);
    });

    const { conversationState } = await import('@/lib/ai/core/conversation-state');
    vi.mocked(conversationState.createAndSetActiveConversation).mockResolvedValue({
      id: 'user-created-conv',
      type: 'global',
      title: null,
      lastMessageAt: null,
      createdAt: new Date().toISOString(),
    });

    const { result } = renderProvider();

    // User creates a conversation while the bootstrap's /active fetch is in flight.
    await act(async () => {
      await result.current.createNewConversation();
    });
    expect(result.current.currentConversationId).toBe('user-created-conv');

    // The stale bootstrap now resolves with the OLD active conversation.
    await act(async () => {
      resolveActive({ ok: true, json: async () => ({ id: 'stale-old-active' }) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.currentConversationId).toBe('user-created-conv');
  });

  it("given loadConversation is called, the cache entry should read loading until its messages fetch resolves", async () => {
    let resolveMessages!: (value: unknown) => void;
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === '/api/ai/global/active') return okResponse({ id: CONV_ID });
      if (url === `/api/ai/global/conv-2/messages?limit=50&includeStreaming=1`) {
        return new Promise((resolve) => { resolveMessages = resolve; });
      }
      return okResponse({ messages: [] });
    });

    const { result } = renderProvider();
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    act(() => {
      void result.current.loadConversation('conv-2');
    });

    // Identity is already 'conv-2' (ungates sends), but messages are still loading.
    expect(result.current.currentConversationId).toBe('conv-2');
    expect(cacheEntry('conv-2').loadStatus).toBe('loading');

    await act(async () => {
      resolveMessages(okResponse({ messages: [] }));
      await Promise.resolve();
    });

    await waitFor(() => expect(cacheEntry('conv-2').loadStatus).toBe('loaded'));
  });

  it("given loadConversation's messages fetch returns a non-ok response, the new conversation's entry should read error with no messages — the previous conversation's messages stay in THEIR OWN entry and cannot render under the new one", async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === '/api/ai/global/active') return okResponse({ id: CONV_ID });
      if (url === `/api/ai/global/${CONV_ID}/messages?limit=50&includeStreaming=1`) {
        return okResponse([{ id: 'stale-msg', role: 'user', parts: [] }]);
      }
      if (url === '/api/ai/global/conv-2/messages?limit=50&includeStreaming=1') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      }
      return okResponse({ messages: [] });
    });

    const { result } = renderProvider();
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));
    await waitFor(() => expect(cacheEntry(CONV_ID).messages).toEqual([
      expect.objectContaining({ id: 'stale-msg' }),
    ]));

    await act(async () => {
      await result.current.loadConversation('conv-2');
    });

    // Per-conversation rendering: conv-2 shows its own (empty, errored) entry —
    // never CONV_ID's messages — with a retry affordance from loadStatus.
    expect(cacheEntry('conv-2').messages).toEqual([]);
    expect(cacheEntry('conv-2').loadStatus).toBe('error');
  });

  // Leaf 5.2 (history-tab rejoin): a conversation opened from a streaming-badged history
  // entry has an in-flight 'streaming' placeholder row that a default fetch excludes — this
  // opts in so selectRenderedMessages can render the live stream in the placeholder's place.
  it("should always request includeStreaming=1 on the conversation's messages fetch", async () => {
    mockFetchWithAuth.mockImplementation(defaultFetch);

    const { result } = renderProvider();
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    await act(async () => {
      await result.current.loadConversation('conv-2');
    });

    expect(mockFetchWithAuth).toHaveBeenCalledWith('/api/ai/global/conv-2/messages?limit=50&includeStreaming=1');
  });
});

// ---------------------------------------------------------------------------
// Bootstrap + live socket events for the global channel — completes the
// streaming-persistence epic by giving the global chat refresh-mid-stream
// visibility (stop button + live append) on par with page chats.
// ---------------------------------------------------------------------------

describe('GlobalChatProvider — global channel stream socket', () => {
  /**
   * SCOPED TO WHAT IS PROVIDER-LEVEL.
   *
   * This describe used to re-test `useChannelStreamSocket`'s internals through an extra layer
   * of mocks — SSE controllers, join rejections, the abort-on-unmount protocol, the
   * consuming-channel gate. Most of those mechanisms are deleted (the subscription lives at
   * module scope in `streamSessionRegistry` now), and the rest are covered directly and more
   * legibly in `hooks/__tests__/useChannelStreamSocket.test.ts` and
   * `lib/ai/streams/__tests__/streamSessionRegistry.test.ts`.
   *
   * What only THIS file can answer is whether the provider wires the user's global channel
   * app-wide, and whether it stays wired.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket._reset();
    mockStreams.clear();
    useConversationMessagesStore.setState({ byConversationId: {} });
    mockUseSocketStore.mockImplementation((selector: (s: { connectionStatus: string }) => unknown) =>
      selector({ connectionStatus: 'connected' })
    );
    mockFetchWithAuth.mockImplementation(defaultFetch);
    mockUseAuth.mockReturnValue({ user: { id: USER_ID }, isAuthenticated: true });
    mockGetBrowserSessionId.mockReturnValue(SESSION_ID_LOCAL);
    mockConsumeStreamJoin.mockResolvedValue({ aborted: false });
    mockAddStream.mockImplementation((stream: Record<string, unknown> & { messageId: string }) => {
      mockStreams.set(stream.messageId, { parts: [], ...stream } as never);
    });
    mockRemoveStream.mockImplementation((messageId: string) => {
      mockStreams.delete(messageId);
    });
  });

  const renderProvider = () =>
    renderHook(() => ({ ...useGlobalChatConversation() }), { wrapper: Wrapper });

  it('given the provider mounts with userId, should fetch active streams for the global channel', async () => {
    renderProvider();

    await waitFor(() => {
      const matched = mockFetchWithAuth.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/api/ai/chat/active-streams'),
      );
      expect(matched).toBeDefined();
      expect(matched?.[0]).toBe(
        `/api/ai/chat/active-streams?channelId=${encodeURIComponent(GLOBAL_CHANNEL_ID)}`,
      );
    });
  });

  it('subscribes the WHOLE channel, not just the conversation on screen', async () => {
    // Deliberately un-narrowed (no `conversationId=` in the bootstrap URL). This provider is
    // what keeps a stream in the store for a conversation no surface is currently showing —
    // panes pass their own conversation id, this one must not.
    renderProvider();

    await waitFor(() => {
      const matched = mockFetchWithAuth.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/api/ai/chat/active-streams'),
      );
      expect(String(matched?.[0])).not.toContain('conversationId=');
    });
  });

  it('given a live stream_start on the global channel, records it in the store', async () => {
    // The end-to-end wiring: socket event -> hook -> registry -> store. The registry is REAL
    // here (only the store and the join are mocked), so this is the provider actually doing
    // its job rather than a mock being asserted against itself.
    renderProvider();
    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_start')).toBeGreaterThan(0));

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-live',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: CONV_ID,
        startedAt: new Date().toISOString(),
        triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
      });
    });

    expect(mockAddStream).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-live', conversationId: CONV_ID, isOwn: true }),
    );
  });

  it("given the SAME ACCOUNT streaming from another tab, records it as the user's OWN", async () => {
    // Leaf 4, at the provider level. This case used to assert `isOwn: false` — keyed on
    // `browserSessionId`, a second tab of the same account read as a stranger, so it rendered
    // the user's own generation unattributed and with no Stop button.
    renderProvider();
    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_start')).toBeGreaterThan(0));

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-other-tab',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: CONV_ID,
        startedAt: new Date().toISOString(),
        triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    expect(mockAddStream).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-other-tab', isOwn: true }),
    );
  });

  it("given ANOTHER USER's stream, records it as not the user's own", async () => {
    renderProvider();
    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_start')).toBeGreaterThan(0));

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-someone-else',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: CONV_ID,
        startedAt: new Date().toISOString(),
        triggeredBy: { userId: 'someone-else', displayName: 'Bob', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    expect(mockAddStream).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-someone-else', isOwn: false }),
    );
  });

  it('given chat:stream_start with a different channel id, should ignore the event', async () => {
    renderProvider();
    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_start')).toBeGreaterThan(0));

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-elsewhere',
        pageId: 'some-other-page',
        conversationId: 'conv-other',
        triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    expect(mockAddStream).not.toHaveBeenCalled();
  });

  it('given the provider unmounts, detaches its socket listeners and TEARS DOWN NOTHING ELSE', async () => {
    // INVERTED FROM WHAT THIS ASSERTED BEFORE, and the inversion is the leaf.
    //
    // It used to require that unmount abort every in-flight SSE controller. That is exactly
    // how "send a message and leave" lost the reply: a generation's visible life was scoped to
    // a React effect. The subscription is the module's now, so unmount detaches listeners and
    // touches no stream — no controller aborted, no store entry dropped, no claim released.
    // The SAME instance that receives the event is the one unmounted — a second render here
    // would leave the recording provider mounted and assert nothing about it (and leak it into
    // the rest of the file).
    const { unmount } = renderProvider();
    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_start')).toBeGreaterThan(0));

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-live',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: CONV_ID,
        startedAt: new Date().toISOString(),
        triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
      });
    });

    unmount();

    expect(mockClearPageStreams).not.toHaveBeenCalled();
    expect(mockRemoveStream).not.toHaveBeenCalled();
  });

  it('given fetch resolves after unmount, should not write the store', async () => {
    // The one thing unmount DOES still guard: an in-flight bootstrap must not apply its result
    // afterwards, because reconciliation acts on a channel-wide view and a late one could tear
    // down sessions a remount has since opened.
    let resolveFetch!: (value: unknown) => void;
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/ai/chat/active-streams')) {
        return new Promise((resolve) => { resolveFetch = resolve; });
      }
      return defaultFetch(url);
    });

    const { unmount } = renderProvider();
    await waitFor(() => expect(resolveFetch).toBeDefined());
    unmount();

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({
          streams: [
            {
              messageId: 'msg-late',
              conversationId: CONV_ID,
              triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
            },
          ],
        }),
      });
    });

    expect(mockAddStream).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-late' }),
    );
  });

  // A load commits the conversation's rev watermark; an event at the next contiguous rev is
  // what makes a direct write happen, and it is what a redelivery is then measured against.
  const revEnvelopeFetch = (rev: number) => (url: string) =>
    url.includes('/messages')
      ? okResponse({ messages: [], pagination: { hasMore: false, nextCursor: null }, rev })
      : defaultFetch(url);

  it('given conversation:message_created at the next rev for the active conversation, should append it to the conversation cache directly and advance the watermark', async () => {
    mockFetchWithAuth.mockImplementation(revEnvelopeFetch(7));

    const { result } = renderProvider();

    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));
    // The load has to have COMMITTED its rev before the event lands — an event
    // against a `null` watermark is a refetch by design, not a direct write.
    await waitFor(() => expect(cacheEntry(CONV_ID).rev).toBe(7));
    await waitFor(() => expect(mockSocket._handlerCount('conversation:message_created')).toBeGreaterThan(0));

    const loadsBefore = messagesFetchCount(CONV_ID);
    const remoteUser = { id: 'msg-remote-user', role: 'user', parts: [{ type: 'text', text: 'remote prompt' }] };

    act(() => {
      mockSocket._trigger('conversation:message_created', {
        conversationId: CONV_ID,
        message: remoteUser,
        rev: 8,
        triggeredBy: { userId: USER_ID, displayName: 'Me-otherTab', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    await waitFor(() => expect(cacheEntry(CONV_ID).messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'msg-remote-user' })]),
    ));
    expect(cacheEntry(CONV_ID).rev).toBe(8);
    // Direct write — no refetch round-trip.
    expect(messagesFetchCount(CONV_ID)).toBe(loadsBefore);
  });

  it('given conversation:message_created for a different conversation, should NOT write the active conversation cache', async () => {
    mockFetchWithAuth.mockImplementation(revEnvelopeFetch(7));

    const { result } = renderProvider();

    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));
    await waitFor(() => expect(mockSocket._handlerCount('conversation:message_created')).toBeGreaterThan(0));

    act(() => {
      mockSocket._trigger('conversation:message_created', {
        conversationId: 'conv-different',
        message: { id: 'msg-stale', role: 'user', parts: [{ type: 'text', text: 'wrong conv' }] },
        rev: 8,
        triggeredBy: { userId: USER_ID, displayName: 'Me-otherTab', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    // Give effects a moment to run
    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    expect(cacheEntry(CONV_ID).messages).toEqual([]);
    expect(cacheEntry('conv-different').messages).toEqual([]);
  });

  // AC8 — unmount safety
});

describe('GlobalChatProvider — editing-store registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket._reset();
    mockStreams.clear();
    // Module state — a real reload clears it; a test file must too.
    useConversationMessagesStore.setState({ byConversationId: {} });
    mockUseSocketStore.mockImplementation((selector: (s: { connectionStatus: string }) => unknown) =>
      selector({ connectionStatus: 'connected' })
    );
    mockFetchWithAuth.mockImplementation(defaultFetch);
    mockUseAuth.mockReturnValue({ user: { id: USER_ID }, isAuthenticated: true });
    mockGetBrowserSessionId.mockReturnValue(SESSION_ID_LOCAL);
    mockConsumeStreamJoin.mockResolvedValue({ aborted: false });
  });

  // THE contract this must protect (repo CLAUDE.md): a streaming registration gates SWR
  // revalidation AND auth-token refresh, and a bootstrap-replayed own stream needs it while every
  // surface's useChat still sits at `idle` after a refresh — the window where the surfaces
  // (which keyed their own registration on useChat status) all reported "not streaming".
  //
  // PR 5A keeps that contract and moves the mechanism: the provider no longer registers one
  // 'global-chat' session flagged by a claim protocol. It renders DerivedStreamingRegistrations,
  // which registers one session PER LIVE CONVERSATION, derived from pendingSends + live store
  // entries. So the assertion moves from "a session named global-chat exists" to the thing that
  // actually matters — a bootstrapped own stream IS registered, with no surface involved.
  it('given a bootstrapped own stream in the store, should register a streaming session for its conversation', async () => {
    mockStreams.set('msg-own', {
      messageId: 'msg-own',
      pageId: GLOBAL_CHANNEL_ID,
      conversationId: CONV_ID,
      triggeredBy: { userId: USER_ID, displayName: 'Me' },
      parts: [],
      isOwn: true,
    });

    renderHook(() => useGlobalChatConversation(), { wrapper: Wrapper });

    await waitFor(() => {
      expect(useStreamingRegistration).toHaveBeenCalledWith(
        `ai-stream-${CONV_ID}`,
        true,
        expect.objectContaining({ conversationId: CONV_ID, componentName: 'GlobalChatProvider' }),
      );
    });
  });

  // The falling edge, and the reason this is keyed by conversation rather than by surface: with
  // nothing live there is nothing to protect, and a session left registered would suppress SWR
  // revalidation for the rest of the app indefinitely.
  it('given no live stream and no pending send, should register nothing', () => {
    renderHook(() => useGlobalChatConversation(), { wrapper: Wrapper });

    expect(useStreamingRegistration).not.toHaveBeenCalled();
  });
});

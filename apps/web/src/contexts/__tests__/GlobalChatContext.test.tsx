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
    mockConsumeStreamJoin: vi.fn().mockResolvedValue(undefined),
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
  useChatTransport: vi.fn().mockReturnValue(null),
  useStreamingRegistration: vi.fn(),
}));

import { GlobalChatProvider, useGlobalChatConversation } from '../GlobalChatContext';
import { useStreamingRegistration } from '@/lib/ai/shared';
import { markChannelConsuming, resetConsumingChannels } from '@/lib/ai/streams/consumingChannels';
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
    resetConsumingChannels();
    useConversationMessagesStore.setState({ byConversationId: {} });
    mockUseSocketStore.mockImplementation((selector: (s: { connectionStatus: string }) => unknown) =>
      selector({ connectionStatus: mockConnectionStatus })
    );
    mockFetchWithAuth.mockImplementation(defaultFetch);
    mockUseAuth.mockReturnValue({ user: { id: USER_ID }, isAuthenticated: true });
    mockGetBrowserSessionId.mockReturnValue(SESSION_ID_LOCAL);
    mockConsumeStreamJoin.mockResolvedValue(undefined);
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
    resetConsumingChannels();
    useConversationMessagesStore.setState({ byConversationId: {} });
    mockUseSocketStore.mockImplementation((selector: (s: { connectionStatus: string }) => unknown) =>
      selector({ connectionStatus: 'disconnected' })
    );
    mockUseAuth.mockReturnValue({ user: { id: USER_ID }, isAuthenticated: true });
    mockGetBrowserSessionId.mockReturnValue(SESSION_ID_LOCAL);
    mockConsumeStreamJoin.mockResolvedValue(undefined);
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
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket._reset();
    mockStreams.clear();
    // Module state — a real reload clears it; a test file must too.
    resetConsumingChannels();
    useConversationMessagesStore.setState({ byConversationId: {} });
    mockUseSocketStore.mockImplementation((selector: (s: { connectionStatus: string }) => unknown) =>
      selector({ connectionStatus: 'connected' })
    );
    mockFetchWithAuth.mockImplementation(defaultFetch);
    mockUseAuth.mockReturnValue({ user: { id: USER_ID }, isAuthenticated: true });
    mockGetBrowserSessionId.mockReturnValue(SESSION_ID_LOCAL);
    mockConsumeStreamJoin.mockResolvedValue(undefined);
    // Wire addStream/removeStream to the in-memory map so onStreamComplete lookups work
    mockAddStream.mockImplementation((stream: { messageId: string; conversationId: string; isOwn: boolean; pageId: string; triggeredBy: { userId: string; displayName: string } }) => {
      mockStreams.set(stream.messageId, { ...stream, parts: [] });
    });
    mockRemoveStream.mockImplementation((messageId: string) => {
      mockStreams.delete(messageId);
    });
  });

  const renderProvider = () =>
    renderHook(
      () => ({ ...useGlobalChatConversation() }),
      { wrapper: Wrapper },
    );

  // AC1
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

  // The SSE join can fail benignly — the stream lives on another web instance, whose
  // in-process multicast registry we cannot reach. It finished fine and the reply IS
  // durably persisted; the store entry was dropped because whatever parts we held were a
  // stale snapshot. Keying purely on "is there still a store entry?" would fall through
  // to "our useChat already has it" and silently lose the reply.
  it('given the SSE join failed and the stream completes for the active conversation, should reload the conversation cache to pick up the persisted reply', async () => {
    const { result } = renderProvider();
    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_complete')).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    const before = messagesFetchCount(CONV_ID);

    // A remote stream arrives, and the SSE join rejects — the stream lives on another
    // web instance whose multicast registry we cannot reach.
    let rejectJoin!: (err: Error) => void;
    mockConsumeStreamJoin.mockReturnValueOnce(new Promise((_res, rej) => { rejectJoin = rej; }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-join-failed',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: CONV_ID,
        triggeredBy: { userId: 'user-other', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
      });
    });
    await act(async () => { rejectJoin(new Error('404 — other instance')); await Promise.resolve(); });

    // The stream finished server-side; the reply is persisted.
    act(() => {
      mockSocket._trigger('chat:stream_complete', {
        messageId: 'msg-join-failed',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: CONV_ID,
      });
    });

    await waitFor(() => expect(messagesFetchCount(CONV_ID)).toBe(before + 1));
    errorSpy.mockRestore();
  });

  // AC2 — own bootstrap stream
  it('given a bootstrapped own stream, should addStream isOwn=true and surface stop via context', async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/api/ai/chat/active-streams')) {
        return okResponse({
          streams: [{
            messageId: 'msg-own',
            conversationId: CONV_ID,
            triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        });
      }
      return defaultFetch(url);
    });

    let pendingResolve!: () => void;
    mockConsumeStreamJoin.mockReturnValueOnce(new Promise((res) => { pendingResolve = () => res(undefined); }));

    renderProvider();

    await waitFor(() => {
      expect(mockAddStream).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'msg-own',
        pageId: GLOBAL_CHANNEL_ID,
        isOwn: true,
      }));
    });

    // NO context isStreaming/stopStreaming assertions (PR 5A): the context no longer projects
    // this into a slot. The addStream above IS the whole contract now — every surface reads it
    // back via useConversationActiveStream and derives its own Stop from it, so what this test
    // must prove is that the bootstrap RECORDS the stream, not that it also installed a stop fn.

    // keep promise alive past test until cleanup
    pendingResolve();
  });

  // AC3 — own bootstrap stream complete via SSE
  it('given an own bootstrap stream resolves via SSE, should remove the store entry and reload the conversation cache', async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/api/ai/chat/active-streams')) {
        return okResponse({
          streams: [{
            messageId: 'msg-own',
            conversationId: CONV_ID,
            triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        });
      }
      return defaultFetch(url);
    });

    let resolveJoin!: () => void;
    mockConsumeStreamJoin.mockReturnValueOnce(new Promise((res) => { resolveJoin = () => res(undefined); }));

    const { result } = renderProvider();

    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    const loadsBefore = messagesFetchCount(CONV_ID);

    await act(async () => { resolveJoin(); });

    // The stream leaving the store is the end of the stream, for every reader (PR 5A).
    await waitFor(() => expect(mockRemoveStream).toHaveBeenCalledWith('msg-own'));

    // The persisted reply reaches the render path via a cache reload (this join
    // delivered no parts, so there is nothing to commit directly).
    await waitFor(() => expect(messagesFetchCount(CONV_ID)).toBeGreaterThan(loadsBefore));
  });

  // AC4 — live cross-tab stream_start
  it('given chat:stream_start from another tab same user, should addStream isOwn=false and start consumeStreamJoin', async () => {
    renderProvider();

    // wait for socket listener registration
    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_start')).toBeGreaterThan(0));

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-remote',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: 'conv-1',
        triggeredBy: { userId: USER_ID, displayName: 'Me-otherTab', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    expect(mockAddStream).toHaveBeenCalledWith({
      messageId: 'msg-remote',
      pageId: GLOBAL_CHANNEL_ID,
      conversationId: 'conv-1',
      triggeredBy: { userId: USER_ID, displayName: 'Me-otherTab', browserSessionId: SESSION_ID_REMOTE },
      isOwn: false,
    });
    expect(mockConsumeStreamJoin).toHaveBeenCalledWith(
      'msg-remote',
      expect.any(AbortSignal),
      expect.any(Function),
    );
    // A cross-tab stream is recorded as NOT ours. That single fact is what keeps it from
    // lighting up this tab's Stop button (selectActiveStream reports isOwn:false, and the
    // surfaces render from that) — where the old code had to remember not to write two
    // context slots.
    expect(mockAddStream).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'msg-remote',
      isOwn: false,
    }));
  });

  // AC5 — own-tab live event filtered
  it('given chat:stream_start from the own browser session while this context is CONSUMING the POST body, should ignore the event', async () => {
    markChannelConsuming(GLOBAL_CHANNEL_ID);
    renderProvider();

    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_start')).toBeGreaterThan(0));

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-self',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: 'conv-1',
        triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
      });
    });

    expect(mockAddStream).not.toHaveBeenCalledWith(expect.objectContaining({ messageId: 'msg-self' }));
    expect(mockConsumeStreamJoin).not.toHaveBeenCalledWith('msg-self', expect.anything(), expect.anything());
  });

  // The reload case: browserSessionId lives in sessionStorage and survives a reload,
  // but the consuming set is module state and does not. A reloaded tab must attach to
  // the stream it started rather than dropping it forever.
  it('given chat:stream_start from the own browser session while NOT consuming (i.e. after a reload), should attach and reclaim the Stop button', async () => {
    renderProvider();

    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_start')).toBeGreaterThan(0));

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-self',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: 'conv-1',
        triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
      });
    });

    expect(mockAddStream).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-self', isOwn: true }),
    );
    expect(mockConsumeStreamJoin).toHaveBeenCalledWith('msg-self', expect.anything(), expect.anything());
  });

  // AC6 — channel filter
  it('given chat:stream_start with a different channel id, should ignore the event', async () => {
    renderProvider();

    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_start')).toBeGreaterThan(0));

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-elsewhere',
        pageId: 'page-xyz',
        conversationId: 'conv-1',
        triggeredBy: { userId: 'u2', displayName: 'Other', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    expect(mockAddStream).not.toHaveBeenCalled();
    expect(mockConsumeStreamJoin).not.toHaveBeenCalled();
  });

  // AC7 — live stream_complete cleanup
  it('given chat:stream_complete for a tracked messageId, should abort SSE, removeStream and reload the conversation cache', async () => {
    let capturedSignal!: AbortSignal;
    mockConsumeStreamJoin.mockImplementationOnce(
      (_id: string, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise(() => {}); // never resolves
      },
    );

    const { result } = renderProvider();

    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_start')).toBeGreaterThan(0));

    // Wait for initial conversation load to finish so onStreamComplete has a conversationId target
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-live',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: CONV_ID,
        triggeredBy: { userId: USER_ID, displayName: 'Me-otherTab', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    const loadsBefore = messagesFetchCount(CONV_ID);

    act(() => {
      mockSocket._trigger('chat:stream_complete', {
        messageId: 'msg-live',
        pageId: GLOBAL_CHANNEL_ID,
        // The server ALWAYS sends this (broadcastAiStreamComplete passes it unconditionally); the
        // type merely marks it optional. Omitting it modelled a payload production never emits —
        // and it matters now: this join never delivered a part, so the hook correctly reports the
        // stream as non-authoritative and drops it, leaving the conversationId as the only way to
        // route the reload-from-DB.
        conversationId: CONV_ID,
      });
    });

    expect(capturedSignal.aborted).toBe(true);
    expect(mockRemoveStream).toHaveBeenCalledWith('msg-live');

    // No parts ever arrived, so there is nothing to commit — the persisted reply
    // reaches the render path via a cache reload.
    await waitFor(() => expect(messagesFetchCount(CONV_ID)).toBeGreaterThan(loadsBefore));
  });

  // cross-tab user_message — a TARGETED cache write, not a whole-conversation refetch
  it('given chat:user_message from another browser session for the active conversation, should append it to the conversation cache directly', async () => {
    const { result } = renderProvider();

    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));
    await waitFor(() => expect(mockSocket._handlerCount('chat:user_message')).toBeGreaterThan(0));

    const loadsBefore = messagesFetchCount(CONV_ID);
    const remoteUser = { id: 'msg-remote-user', role: 'user', parts: [{ type: 'text', text: 'remote prompt' }] };

    act(() => {
      mockSocket._trigger('chat:user_message', {
        message: remoteUser,
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: CONV_ID,
        triggeredBy: { userId: USER_ID, displayName: 'Me-otherTab', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    await waitFor(() => expect(cacheEntry(CONV_ID).messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'msg-remote-user' })]),
    ));
    // Direct write — no refetch round-trip.
    expect(messagesFetchCount(CONV_ID)).toBe(loadsBefore);
  });

  it('given chat:user_message for a different conversation, should NOT write the active conversation cache', async () => {
    const { result } = renderProvider();

    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));
    await waitFor(() => expect(mockSocket._handlerCount('chat:user_message')).toBeGreaterThan(0));

    act(() => {
      mockSocket._trigger('chat:user_message', {
        message: { id: 'msg-stale', role: 'user', parts: [{ type: 'text', text: 'wrong conv' }] },
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: 'conv-different',
        triggeredBy: { userId: USER_ID, displayName: 'Me-otherTab', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    // Give effects a moment to run
    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    expect(cacheEntry(CONV_ID).messages).toEqual([]);
    expect(cacheEntry('conv-different').messages).toEqual([]);
  });

  // AC8 — unmount safety
  it('given the provider unmounts, should abort in-flight SSE controllers and remove socket listeners', async () => {
    let capturedSignal!: AbortSignal;
    mockConsumeStreamJoin.mockImplementationOnce(
      (_id: string, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise(() => {});
      },
    );

    const { unmount } = renderProvider();

    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_start')).toBeGreaterThan(0));

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-live',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: 'conv-1',
        triggeredBy: { userId: USER_ID, displayName: 'Me-otherTab', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    unmount();

    expect(capturedSignal.aborted).toBe(true);
    expect(mockSocket.off).toHaveBeenCalledWith('chat:stream_start', expect.any(Function));
    expect(mockSocket.off).toHaveBeenCalledWith('chat:stream_complete', expect.any(Function));
  });

  // Codex P1 — SSE join failure on own bootstrap stream must not strand UI
  it('given an own bootstrap stream and consumeStreamJoin rejects, should clear context streaming flags', async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/api/ai/chat/active-streams')) {
        return okResponse({
          streams: [{
            messageId: 'msg-own',
            conversationId: CONV_ID,
            triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        });
      }
      return defaultFetch(url);
    });

    let rejectJoin!: (err: Error) => void;
    mockConsumeStreamJoin.mockReturnValueOnce(
      new Promise((_res, rej) => { rejectJoin = rej; }),
    );

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderProvider();

    await waitFor(() => expect(mockAddStream).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'msg-own',
      isOwn: true,
    })));

    await act(async () => {
      rejectJoin(new Error('network down'));
      await Promise.resolve();
    });

    // The join failed, so there is nothing to render and nothing to stop — the store entry must
    // go, because after PR 5A that entry IS what every surface's Stop button and streaming
    // indicator read. Leaving it would strand a Stop for a stream this tab cannot reach.
    await waitFor(() => expect(mockRemoveStream).toHaveBeenCalledWith('msg-own'));

    errorSpy.mockRestore();
  });

  // Codex P1 follow-up — after a failed SSE join, stream_complete must not
  // trigger a second reload (stream already removed from store, no conversationId routed)
  it('given own SSE rejected then chat:stream_complete fires without a conversationId, should not reload again', async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/api/ai/chat/active-streams')) {
        return okResponse({
          streams: [{
            messageId: 'msg-own',
            conversationId: CONV_ID,
            triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        });
      }
      return defaultFetch(url);
    });

    let rejectJoin!: (err: Error) => void;
    mockConsumeStreamJoin.mockReturnValueOnce(
      new Promise((_res, rej) => { rejectJoin = rej; }),
    );

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderProvider();

    await waitFor(() => expect(mockAddStream).toHaveBeenCalled());

    await act(async () => {
      rejectJoin(new Error('network down'));
      await Promise.resolve();
    });

    // Stream has been removed from the store by the catch path
    await waitFor(() => expect(mockRemoveStream).toHaveBeenCalledWith('msg-own'));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));
    const loadsAfterCatch = messagesFetchCount(CONV_ID);

    act(() => {
      mockSocket._trigger('chat:stream_complete', {
        messageId: 'msg-own',
        pageId: GLOBAL_CHANNEL_ID,
      });
    });

    // stream_complete is a no-op — no store entry and no conversationId to route a reload
    expect(messagesFetchCount(CONV_ID)).toBe(loadsAfterCatch);

    errorSpy.mockRestore();
  });

  // Codex P2 — finalize must not run after teardown
  it('given a stream resolves after unmount via aborted SSE, should not throw or side-effect post-unmount', async () => {
    let resolveJoin!: () => void;
    mockConsumeStreamJoin.mockImplementationOnce(
      (_id: string, _signal: AbortSignal) =>
        new Promise<undefined>((res) => { resolveJoin = () => res(undefined); }),
    );

    const { unmount } = renderProvider();

    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_start')).toBeGreaterThan(0));

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-live',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: 'conv-1',
        triggeredBy: { userId: USER_ID, displayName: 'Other', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    unmount();

    // Now resolve the SSE — simulates abort-triggered resolution post-unmount
    // This must not throw and must not cause any side effects (React 18 silently
    // drops setState calls on unmounted components).
    await act(async () => { resolveJoin(); await Promise.resolve(); });

    // No assertions on component state (unmounted), but the test passes if no
    // errors are thrown — verifying the unmount guard works correctly.
  });

  // AC8 — bootstrap unmount cancellation
  it('given fetch resolves after unmount, should not call addStream', async () => {
    let resolveFetch!: (value: unknown) => void;
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/api/ai/chat/active-streams')) {
        return new Promise((res) => { resolveFetch = res; });
      }
      return defaultFetch(url);
    });

    const { unmount } = renderProvider();

    unmount();

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-late',
            conversationId: 'conv-1',
            triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        }),
      });
      await Promise.resolve();
    });

    expect(mockAddStream).not.toHaveBeenCalled();
    expect(mockConsumeStreamJoin).not.toHaveBeenCalled();
  });
});

describe('GlobalChatProvider — editing-store registration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket._reset();
    mockStreams.clear();
    // Module state — a real reload clears it; a test file must too.
    resetConsumingChannels();
    useConversationMessagesStore.setState({ byConversationId: {} });
    mockUseSocketStore.mockImplementation((selector: (s: { connectionStatus: string }) => unknown) =>
      selector({ connectionStatus: 'connected' })
    );
    mockFetchWithAuth.mockImplementation(defaultFetch);
    mockUseAuth.mockReturnValue({ user: { id: USER_ID }, isAuthenticated: true });
    mockGetBrowserSessionId.mockReturnValue(SESSION_ID_LOCAL);
    mockConsumeStreamJoin.mockResolvedValue(undefined);
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

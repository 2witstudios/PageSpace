import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import React from 'react';

// --- Mocks (hoisted so vi.mock factories can reference them) ---

const SESSION_ID_LOCAL = 'session-current';
const SESSION_ID_REMOTE = 'session-other';

const {
  mockUseSocketStore,
  mockSocket,
  mockUseAuth,
  mockAddStream,
  mockAppendText,
  mockRemoveStream,
  mockClearPageStreams,
  mockConsumeStreamJoin,
  mockAbortActiveStreamByMessageId,
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
    mockAppendText: vi.fn(),
    mockRemoveStream: vi.fn(),
    mockClearPageStreams: vi.fn(),
    mockConsumeStreamJoin: vi.fn().mockResolvedValue(undefined),
    mockAbortActiveStreamByMessageId: vi.fn().mockResolvedValue({ aborted: true, reason: '' }),
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

vi.mock('@/stores/usePendingStreamsStore', () => ({
  usePendingStreamsStore: {
    getState: () => ({
      addStream: mockAddStream,
      appendText: mockAppendText,
      removeStream: mockRemoveStream,
      clearPageStreams: mockClearPageStreams,
    }),
  },
}));

vi.mock('@/lib/ai/core/stream-join-client', () => ({
  consumeStreamJoin: mockConsumeStreamJoin,
}));

vi.mock('@/lib/ai/core/stream-abort-client', () => ({
  abortActiveStreamByMessageId: mockAbortActiveStreamByMessageId,
}));

vi.mock('@/lib/ai/core/browser-session-id', () => ({
  getBrowserSessionId: mockGetBrowserSessionId,
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

vi.mock('@/lib/ai/shared', () => ({
  useChatTransport: vi.fn().mockReturnValue(null),
}));

import { GlobalChatProvider, useGlobalChat, useGlobalChatConversation } from '../GlobalChatContext';

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

// --- Tests ---

describe('GlobalChatProvider — socket reconnect refresh', () => {
  let mockConnectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';

  beforeEach(() => {
    mockConnectionStatus = 'disconnected';
    vi.clearAllMocks();
    mockSocket._reset();
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

  it('given isInitialized=true and currentConversationId set, when socket reconnects (second connect), should call refreshConversation exactly once', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    // First connect — sets the ref, no refresh
    setStatus('connected', rerender);

    const messagesCallsAfterFirstConnect = mockFetchWithAuth.mock.calls.filter(
      ([url]) => (url as string).includes('/messages')
    ).length;

    // Disconnect then reconnect
    setStatus('disconnected', rerender);
    setStatus('connected', rerender);

    await waitFor(() => {
      const messageCalls = mockFetchWithAuth.mock.calls.filter(
        ([url]) => (url as string).includes('/messages')
      );
      expect(messageCalls.length).toBe(messagesCallsAfterFirstConnect + 1);
    });
  });

  it('given socket fires connected for the first time (initial load), should NOT call refreshConversation', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    const callsBefore = mockFetchWithAuth.mock.calls.length;

    // First connect
    setStatus('connected', rerender);

    await waitFor(() => expect(mockFetchWithAuth.mock.calls.length).toBe(callsBefore));
  });

  // NOTE: React testing-library's act() collapses isInitialized false→true into one render,
  // masking the production loop in isolation. This test validates the no-cascade invariant.
  // Two fixes in GlobalChatContext guard against the loop: prevConnectionStatusRef (prevents
  // the effect re-firing when status hasn't changed) and isInitializedRef (prevents isInitialized
  // from being a reactive dep that re-triggers the effect after each refresh).
  it('given refresh completes after reconnect (isInitialized cycles true→false→true), should NOT trigger a second refresh', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    // First connect — sets hasInitialConnectRef, no refresh
    setStatus('connected', rerender);
    setStatus('disconnected', rerender);

    // Capture count BEFORE the reconnect so we can detect growth
    const countBeforeReconnect = mockFetchWithAuth.mock.calls.filter(
      ([url]) => (url as string).includes('/messages')
    ).length;

    // Reconnect — triggers the reconnect refresh
    setStatus('connected', rerender);

    // Wait until the reconnect refresh has fired (messages count grew by 1)
    await waitFor(() => {
      const calls = mockFetchWithAuth.mock.calls.filter(([url]) => (url as string).includes('/messages'));
      expect(calls.length).toBeGreaterThan(countBeforeReconnect);
    });

    const countAfterFirstRefresh = mockFetchWithAuth.mock.calls.filter(
      ([url]) => (url as string).includes('/messages')
    ).length;

    // Allow any cascade effects to settle
    await waitFor(() =>
      expect(
        mockFetchWithAuth.mock.calls.filter(([url]) => (url as string).includes('/messages')).length
      ).toBe(countAfterFirstRefresh)
    );

    // No second refresh should have fired
    expect(
      mockFetchWithAuth.mock.calls.filter(([url]) => (url as string).includes('/messages')).length
    ).toBe(countAfterFirstRefresh);
  });

  it('given socket is already connected when currentConversationId changes (conversation switch), should NOT trigger a spurious refresh', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    // Initial connect — sets hasInitialConnectRef, no refresh
    setStatus('connected', rerender);

    const CONV_ID_2 = 'conv-2';
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url === `/api/ai/global/${CONV_ID_2}/messages?limit=50`) return okResponse([]);
      return defaultFetch(url);
    });

    const callsBefore = mockFetchWithAuth.mock.calls.filter(
      ([url]) => (url as string).includes('/messages')
    ).length;

    // Switch conversation while connected — should NOT trigger reconnect refresh
    act(() => { result.current.loadConversation(CONV_ID_2); });

    // Wait for the load to complete
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID_2));

    const callsAfter = mockFetchWithAuth.mock.calls.filter(
      ([url]) => (url as string).includes('/messages')
    ).length;

    // Only the explicit loadConversation fetch, no extra reconnect refresh
    expect(callsAfter).toBe(callsBefore + 1);
  });

  it('given isInitialized=false when reconnect fires, should NOT call refreshConversation', async () => {
    // Hang initialization so isInitialized stays false
    mockFetchWithAuth.mockImplementation(() => new Promise(() => {}));

    const { result, rerender } = renderProvider();

    expect(result.current.isInitialized).toBe(false);

    // First connect — sets hasInitialConnectRef to true
    setStatus('connected', rerender);
    setStatus('disconnected', rerender);
    // Second connect — isInitialized still false, should not refresh
    setStatus('connected', rerender);

    // The bootstrap effect always fetches active-streams once on mount; that call
    // is unrelated to refreshConversation and must be excluded from the assertion.
    await waitFor(() => {
      const conversationCalls = mockFetchWithAuth.mock.calls.filter(
        ([url]) => typeof url === 'string' && !(url as string).includes('/api/ai/chat/active-streams'),
      );
      expect(conversationCalls).toHaveLength(1);
    });
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
    mockUseSocketStore.mockImplementation((selector: (s: { connectionStatus: string }) => unknown) =>
      selector({ connectionStatus: 'connected' })
    );
    mockFetchWithAuth.mockImplementation(defaultFetch);
    mockUseAuth.mockReturnValue({ user: { id: USER_ID }, isAuthenticated: true });
    mockGetBrowserSessionId.mockReturnValue(SESSION_ID_LOCAL);
    mockConsumeStreamJoin.mockResolvedValue(undefined);
  });

  const renderProvider = () =>
    renderHook(() => useGlobalChat(), { wrapper: Wrapper });

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

  // AC2 — own bootstrap stream
  it('given a bootstrapped own stream, should addStream isOwn=true and surface stop via context', async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/api/ai/chat/active-streams')) {
        return okResponse({
          streams: [{
            messageId: 'msg-own',
            conversationId: 'conv-own',
            triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        });
      }
      return defaultFetch(url);
    });

    let pendingResolve!: () => void;
    mockConsumeStreamJoin.mockReturnValueOnce(new Promise((res) => { pendingResolve = () => res(undefined); }));

    const { result } = renderProvider();

    await waitFor(() => {
      expect(mockAddStream).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'msg-own',
        pageId: GLOBAL_CHANNEL_ID,
        isOwn: true,
      }));
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(true));
    expect(typeof result.current.stopStreaming).toBe('function');

    // Invoking the registered stop should hit abortActiveStreamByMessageId
    act(() => { result.current.stopStreaming?.(); });
    expect(mockAbortActiveStreamByMessageId).toHaveBeenCalledWith({ messageId: 'msg-own' });

    // keep promise alive past test until cleanup
    pendingResolve();
  });

  // AC3 — own bootstrap stream complete via SSE
  it('given an own bootstrap stream resolves via SSE, should clear context streaming + refresh conversation', async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/api/ai/chat/active-streams')) {
        return okResponse({
          streams: [{
            messageId: 'msg-own',
            conversationId: 'conv-own',
            triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        });
      }
      return defaultFetch(url);
    });

    let resolveJoin!: () => void;
    mockConsumeStreamJoin.mockReturnValueOnce(new Promise((res) => { resolveJoin = () => res(undefined); }));

    const { result } = renderProvider();

    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    const messagesCallsBefore = mockFetchWithAuth.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('/messages'),
    ).length;

    await act(async () => { resolveJoin(); });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.stopStreaming).toBeNull();
    expect(mockRemoveStream).toHaveBeenCalledWith('msg-own');

    await waitFor(() => {
      const messagesCallsAfter = mockFetchWithAuth.mock.calls.filter(
        ([url]) => typeof url === 'string' && (url as string).includes('/messages'),
      ).length;
      expect(messagesCallsAfter).toBeGreaterThan(messagesCallsBefore);
    });
  });

  // AC4 — live cross-tab stream_start
  it('given chat:stream_start from another tab same user, should addStream isOwn=false and start consumeStreamJoin without touching context streaming flags', async () => {
    const { result } = renderProvider();

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
    // Cross-tab streams must NOT mutate the local streaming flags — only the
    // owning tab's useChat hook should drive the local stop button surface.
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.stopStreaming).toBeNull();
  });

  // AC5 — own-tab live event filtered
  it('given chat:stream_start from the own browser session, should ignore the event', async () => {
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
  it('given chat:stream_complete for a tracked messageId, should abort SSE, removeStream and refresh conversation', async () => {
    let capturedSignal!: AbortSignal;
    mockConsumeStreamJoin.mockImplementationOnce(
      (_id: string, signal: AbortSignal) => {
        capturedSignal = signal;
        return new Promise(() => {}); // never resolves
      },
    );

    const { result } = renderProvider();

    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_start')).toBeGreaterThan(0));

    // Wait for initial conversation load to finish so refreshConversation has a target
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    act(() => {
      mockSocket._trigger('chat:stream_start', {
        messageId: 'msg-live',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: 'conv-1',
        triggeredBy: { userId: USER_ID, displayName: 'Me-otherTab', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    const messagesCallsBefore = mockFetchWithAuth.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('/messages'),
    ).length;

    act(() => {
      mockSocket._trigger('chat:stream_complete', {
        messageId: 'msg-live',
        pageId: GLOBAL_CHANNEL_ID,
      });
    });

    expect(capturedSignal.aborted).toBe(true);
    expect(mockRemoveStream).toHaveBeenCalledWith('msg-live');

    await waitFor(() => {
      const messagesCallsAfter = mockFetchWithAuth.mock.calls.filter(
        ([url]) => typeof url === 'string' && (url as string).includes('/messages'),
      ).length;
      expect(messagesCallsAfter).toBeGreaterThan(messagesCallsBefore);
    });
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
            conversationId: 'conv-own',
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

    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    await act(async () => {
      rejectJoin(new Error('network down'));
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.stopStreaming).toBeNull();
    expect(mockRemoveStream).toHaveBeenCalledWith('msg-own');

    errorSpy.mockRestore();
  });

  // Codex P1 follow-up — after a failed SSE join, a later complete event must
  // not double-clear flags; the catch path already finalized the stream.
  it('given own SSE rejected then chat:stream_complete fires, should not refresh twice', async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/api/ai/chat/active-streams')) {
        return okResponse({
          streams: [{
            messageId: 'msg-own',
            conversationId: 'conv-own',
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

    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    await act(async () => {
      rejectJoin(new Error('network down'));
      await Promise.resolve();
    });

    const messagesCallsAfterCatch = mockFetchWithAuth.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('/messages'),
    ).length;

    act(() => {
      mockSocket._trigger('chat:stream_complete', {
        messageId: 'msg-own',
        pageId: GLOBAL_CHANNEL_ID,
      });
    });

    // No additional /messages refresh — finalize is a no-op on already-finalized id
    const messagesCallsAfterComplete = mockFetchWithAuth.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('/messages'),
    ).length;
    expect(messagesCallsAfterComplete).toBe(messagesCallsAfterCatch);

    errorSpy.mockRestore();
  });

  // Codex P2 — finalize must not run after teardown
  it('given a stream resolves after unmount via aborted SSE, should not call refreshConversation post-unmount', async () => {
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

    const messagesCallsBeforeUnmount = mockFetchWithAuth.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('/messages'),
    ).length;

    unmount();

    // Now resolve the SSE — simulates abort-triggered resolution post-unmount
    await act(async () => { resolveJoin(); await Promise.resolve(); });

    const messagesCallsAfterUnmount = mockFetchWithAuth.mock.calls.filter(
      ([url]) => typeof url === 'string' && (url as string).includes('/messages'),
    ).length;
    expect(messagesCallsAfterUnmount).toBe(messagesCallsBeforeUnmount);
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

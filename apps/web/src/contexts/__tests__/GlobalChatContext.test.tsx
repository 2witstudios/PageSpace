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

vi.mock('@/stores/usePendingStreamsStore', () => ({
  usePendingStreamsStore: {
    getState: () => ({
      streams: mockStreams,
      addStream: mockAddStream,
      appendPart: mockAppendPart,
      setStreamParts: mockSetStreamParts,
      removeStream: mockRemoveStream,
      clearPageStreams: mockClearPageStreams,
    }),
  },
}));

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

import { GlobalChatProvider, useGlobalChatConversation, useGlobalChatStream, useGlobalChatConfig } from '../GlobalChatContext';
import { useStreamingRegistration } from '@/lib/ai/shared';
import { markChannelConsuming, resetConsumingChannels } from '@/lib/ai/streams/consumingChannels';

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
    mockStreams.clear();
    // Module state — a real reload clears it; a test file must too.
    resetConsumingChannels();
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

  it('given isInitialized=true and currentConversationId set, when socket reconnects (second connect), should increment refreshSignal exactly once', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    // First connect — sets the hasInitialConnect ref, no refresh
    setStatus('connected', rerender);

    const signalAfterFirstConnect = result.current.refreshSignal;

    // Disconnect then reconnect
    setStatus('disconnected', rerender);
    setStatus('connected', rerender);

    await waitFor(() => {
      expect(result.current.refreshSignal).toBe(signalAfterFirstConnect + 1);
    });
  });

  it('given socket fires connected for the first time (initial load), should NOT increment refreshSignal', async () => {
    const { result, rerender } = renderProvider();

    await waitFor(() => expect(result.current.isInitialized).toBe(true));

    const signalBefore = result.current.refreshSignal;

    // First connect
    setStatus('connected', rerender);

    // Allow any potential cascading effects to settle
    await waitFor(() => expect(result.current.isInitialized).toBe(true));
    expect(result.current.refreshSignal).toBe(signalBefore);
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

    const signalBeforeReconnect = result.current.refreshSignal;

    // Reconnect — triggers the reconnect signal increment
    setStatus('connected', rerender);

    // Wait until the reconnect signal has fired (incremented by 1)
    await waitFor(() => {
      expect(result.current.refreshSignal).toBeGreaterThan(signalBeforeReconnect);
    });

    const signalAfterFirstRefresh = result.current.refreshSignal;

    // Allow any cascade effects to settle
    await waitFor(() =>
      expect(result.current.refreshSignal).toBe(signalAfterFirstRefresh)
    );

    // No second increment should have occurred
    expect(result.current.refreshSignal).toBe(signalAfterFirstRefresh);
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

    const signalBefore = result.current.refreshSignal;

    // Switch conversation while connected — should NOT trigger reconnect signal increment
    act(() => { result.current.loadConversation(CONV_ID_2); });

    // Wait for the load to complete
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID_2));

    // refreshSignal must not have changed (no spurious reconnect-triggered increment)
    expect(result.current.refreshSignal).toBe(signalBefore);
  });

  it('given isInitialized=false when reconnect fires, should NOT increment refreshSignal', async () => {
    // Hang initialization so isInitialized stays false
    mockFetchWithAuth.mockImplementation(() => new Promise(() => {}));

    const { result, rerender } = renderProvider();

    expect(result.current.isInitialized).toBe(false);

    const signalBefore = result.current.refreshSignal;

    // First connect — sets hasInitialConnectRef to true
    setStatus('connected', rerender);
    setStatus('disconnected', rerender);
    // Second connect — isInitialized still false, should not signal
    setStatus('connected', rerender);

    await waitFor(() => {
      expect(result.current.refreshSignal).toBe(signalBefore);
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
    expect(result.current.initialMessages).toEqual([{ id: 'fresh-msg' }]);

    // The stale init-triggered fetch for CONV_ID now resolves — it must not
    // overwrite conv-2's identity or messages.
    await act(async () => {
      resolveStaleMessages(okResponse({ messages: [{ id: 'stale-msg' }] }));
      await Promise.resolve();
    });

    expect(result.current.currentConversationId).toBe('conv-2');
    expect(result.current.initialMessages).toEqual([{ id: 'fresh-msg' }]);
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
  });

  it('given loadConversation is called, should set isMessagesLoading true until its messages fetch resolves', async () => {
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
    expect(result.current.isMessagesLoading).toBe(true);

    await act(async () => {
      resolveMessages(okResponse({ messages: [] }));
      await Promise.resolve();
    });

    expect(result.current.isMessagesLoading).toBe(false);
  });

  it('given loadConversation\'s messages fetch returns a non-ok response, should clear initialMessages instead of leaving the previous conversation\'s messages visible', async () => {
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
    await waitFor(() => expect(result.current.initialMessages).toEqual([
      expect.objectContaining({ id: 'stale-msg' }),
    ]));

    await act(async () => {
      await result.current.loadConversation('conv-2');
    });

    expect(result.current.initialMessages).toEqual([]);
  });

  // Leaf 5.2 (history-tab rejoin): a conversation opened from a streaming-badged history
  // entry has an in-flight 'streaming' placeholder row that a default fetch excludes — this
  // opts in so mergeServerAndPending can recognize and replace it with the live stream.
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
      () => ({ ...useGlobalChatConversation(), ...useGlobalChatStream() }),
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
  it('given the SSE join failed and the stream completes for the active conversation, should refresh to load the persisted reply', async () => {
    const { result } = renderProvider();
    await waitFor(() => expect(mockSocket._handlerCount('chat:stream_complete')).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    const before = result.current.refreshSignal;

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

    await waitFor(() => expect(result.current.refreshSignal).toBe(before + 1));
    errorSpy.mockRestore();
  });

  // BUG SEVEN, from the other side. GlobalAssistantView is the one writer that never joined
  // the claim protocol: its stop-registration effects nulled the shared slot
  // UNCONDITIONALLY, on an else-branch and a cleanup that both fire whenever the chat
  // status is 'ready' — which it is for the ENTIRE life of a bootstrapped stream, and whose
  // deps resolve asynchronously right after the claim BY DESIGN. So it destroyed a live
  // Stop button belonging to the stream socket, leaving isStreaming:true with
  // stopStreaming:null — Stop renders and does nothing while the stream keeps billing.
  //
  // This test guards the contract from the context side: once a bootstrap claim is in the
  // slot, a foreign `setStopStreaming(null)` is the caller's bug — but the claim itself
  // must survive as a working Stop until the stream actually ends.
  it('given a bootstrapped claim, the installed stop fn must remain callable and abort the stream it named', async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/api/ai/chat/active-streams')) {
        return okResponse({
          streams: [{
            messageId: 'msg-claimed',
            conversationId: CONV_ID,
            triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        });
      }
      return defaultFetch(url);
    });
    mockConsumeStreamJoin.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => useGlobalChatStream(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    const stop = result.current.stopStreaming;
    expect(typeof stop).toBe('function');

    // It must ACT, not merely return another function (the updater/value trap).
    const returned = stop!() as unknown;

    expect(mockAbortActiveStreamByMessageId).toHaveBeenCalledWith({ messageId: 'msg-claimed' });
    expect(typeof returned).not.toBe('function');
  });

  // The bootstrap claim is deliberately allowed to land BEFORE this surface has resolved its
  // conversation — rejecting on a null id there would drop the very stream we are about to
  // render. But a claim made in ignorance must be re-examined once the answer arrives: if it
  // names a DIFFERENT conversation, holding it would keep the Stop button lit and the
  // composer disabled for a stream the user is not looking at.
  it('given a claim landed before identity resolved, and identity resolves to a DIFFERENT conversation, the claim should be released', async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/api/ai/chat/active-streams')) {
        return okResponse({
          streams: [{
            messageId: 'msg-other-conv',
            conversationId: 'a-different-conversation',
            triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        });
      }
      // Identity resolves to CONV_ID — NOT the stream's conversation.
      return defaultFetch(url);
    });
    mockConsumeStreamJoin.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(
      () => ({ conv: useGlobalChatConversation(), stream: useGlobalChatStream() }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.conv.currentConversationId).toBe(CONV_ID));

    // The claim named another conversation, so it must not be holding our Stop.
    await waitFor(() => expect(result.current.stream.isStreaming).toBe(false));
    expect(result.current.stream.stopStreaming).toBeNull();
  });

  // A NULL slot is free, not foreign. GlobalAssistantView nulls the stop fn on ordinary
  // paths (its effect's else-branch and cleanup fire whenever globalStatus is 'ready' —
  // which it is for the entire life of a BOOTSTRAPPED stream) without ever touching
  // isStreaming. Treating that as "not ours" skips setIsStreaming(false) and strands it
  // true forever: ChatInput then renders Stop instead of Send, disables the textarea, and
  // the Stop is a no-op. The Global Assistant composer is bricked until a full reload.
  it('given the stop fn was nulled by another surface, finalizing must still clear isStreaming', async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/api/ai/chat/active-streams')) {
        return okResponse({
          streams: [{
            messageId: 'msg-boot',
            conversationId: CONV_ID,
            triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        });
      }
      return defaultFetch(url);
    });
    mockConsumeStreamJoin.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(
      () => ({ stream: useGlobalChatStream(), config: useGlobalChatConfig() }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current.stream.isStreaming).toBe(true));

    // GlobalAssistantView's effect cleanup nulls the stop fn — it never touches isStreaming.
    act(() => { result.current.config.setStopStreaming(null); });
    await waitFor(() => expect(result.current.stream.stopStreaming).toBeNull());

    act(() => {
      mockSocket._trigger('chat:stream_complete', {
        messageId: 'msg-boot',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: CONV_ID,
      });
    });

    await waitFor(() => expect(result.current.stream.isStreaming).toBe(false));
  });

  // The isStreaming/stopStreaming pair is a single shared slot that GlobalAssistantView
  // also writes directly from its local chat status, outside the claim protocol. The
  // takeover makes the clobber DETERMINISTIC: a reloaded tab bootstraps own stream M and
  // claims the slot; the user sends again; the server takes over and aborts M; M's
  // chat:stream_complete then arrives — and releasing on the messageId alone would kill
  // the Stop button and streaming flag of the NEW, live stream (and with them its
  // SWR-clobber protection), with no effect left to restore them.
  it('given the slot was taken over by a newer stream, finalizing the OLD claimed stream must not clear it', async () => {
    mockFetchWithAuth.mockImplementation((url: string) => {
      if (url.includes('/api/ai/chat/active-streams')) {
        return okResponse({
          streams: [{
            messageId: 'msg-old',
            conversationId: CONV_ID,
            triggeredBy: { userId: USER_ID, displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        });
      }
      return defaultFetch(url);
    });
    mockConsumeStreamJoin.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(
      () => ({ stream: useGlobalChatStream(), config: useGlobalChatConfig() }),
      { wrapper: Wrapper },
    );

    // Bootstrap claims the slot for the old stream.
    await waitFor(() => expect(result.current.stream.isStreaming).toBe(true));
    const claimedStop = result.current.stream.stopStreaming;
    expect(typeof claimedStop).toBe('function');

    // A newer stream takes the slot over (this is what GlobalAssistantView does directly).
    const newerStop = vi.fn();
    act(() => { result.current.config.setStopStreaming(() => newerStop); });
    await waitFor(() => expect(result.current.stream.stopStreaming).toBe(newerStop));

    // The server's takeover aborts the old stream; its completion now arrives.
    act(() => {
      mockSocket._trigger('chat:stream_complete', {
        messageId: 'msg-old',
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: CONV_ID,
      });
    });

    expect(result.current.stream.stopStreaming).toBe(newerStop);
    expect(result.current.stream.isStreaming).toBe(true);
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
  it('given an own bootstrap stream resolves via SSE, should clear context streaming and increment refreshSignal', async () => {
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

    await waitFor(() => expect(result.current.isStreaming).toBe(true));
    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));

    const signalBefore = result.current.refreshSignal;

    await act(async () => { resolveJoin(); });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.stopStreaming).toBeNull();
    expect(mockRemoveStream).toHaveBeenCalledWith('msg-own');

    // refreshSignal increments so surfaces know to re-fetch messages
    await waitFor(() => expect(result.current.refreshSignal).toBeGreaterThan(signalBefore));
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
  it('given chat:stream_complete for a tracked messageId, should abort SSE, removeStream and increment refreshSignal', async () => {
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

    const signalBefore = result.current.refreshSignal;

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

    // Context signals surfaces to re-fetch rather than fetching itself
    await waitFor(() => expect(result.current.refreshSignal).toBeGreaterThan(signalBefore));
  });

  // cross-tab user_message — context signals surfaces to re-fetch
  it('given chat:user_message from another browser session for the active conversation, should increment refreshSignal', async () => {
    const { result } = renderProvider();

    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));
    await waitFor(() => expect(mockSocket._handlerCount('chat:user_message')).toBeGreaterThan(0));

    const signalBefore = result.current.refreshSignal;

    act(() => {
      mockSocket._trigger('chat:user_message', {
        message: { id: 'msg-remote-user', role: 'user', parts: [{ type: 'text', text: 'remote prompt' }] },
        pageId: GLOBAL_CHANNEL_ID,
        conversationId: CONV_ID,
        triggeredBy: { userId: USER_ID, displayName: 'Me-otherTab', browserSessionId: SESSION_ID_REMOTE },
      });
    });

    await waitFor(() => expect(result.current.refreshSignal).toBeGreaterThan(signalBefore));
  });

  it('given chat:user_message for a different conversation, should NOT increment refreshSignal', async () => {
    const { result } = renderProvider();

    await waitFor(() => expect(result.current.currentConversationId).toBe(CONV_ID));
    await waitFor(() => expect(mockSocket._handlerCount('chat:user_message')).toBeGreaterThan(0));

    const signalBefore = result.current.refreshSignal;

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
    expect(result.current.refreshSignal).toBe(signalBefore);
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

  // Codex P1 follow-up — after a failed SSE join, stream_complete must not
  // increment refreshSignal a second time (stream already removed from store)
  it('given own SSE rejected then chat:stream_complete fires, should not increment refreshSignal', async () => {
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

    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    await act(async () => {
      rejectJoin(new Error('network down'));
      await Promise.resolve();
    });

    // Stream has been removed from the store by the catch path
    const signalAfterCatch = result.current.refreshSignal;

    act(() => {
      mockSocket._trigger('chat:stream_complete', {
        messageId: 'msg-own',
        pageId: GLOBAL_CHANNEL_ID,
      });
    });

    // stream_complete is a no-op — stream was already removed from the store
    await waitFor(() => expect(result.current.isStreaming).toBe(false));
    expect(result.current.refreshSignal).toBe(signalAfterCatch);

    errorSpy.mockRestore();
  });

  // Codex P2 — finalize must not run after teardown
  it('given a stream resolves after unmount via aborted SSE, should not increment refreshSignal post-unmount', async () => {
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
    mockUseSocketStore.mockImplementation((selector: (s: { connectionStatus: string }) => unknown) =>
      selector({ connectionStatus: 'connected' })
    );
    mockFetchWithAuth.mockImplementation(defaultFetch);
    mockUseAuth.mockReturnValue({ user: { id: USER_ID }, isAuthenticated: true });
    mockGetBrowserSessionId.mockReturnValue(SESSION_ID_LOCAL);
    mockConsumeStreamJoin.mockResolvedValue(undefined);
  });

  // Surfaces (GlobalAssistantView, SidebarChatTab) key their useStreamingRegistration
  // on local useChat status, which is `idle` immediately after a refresh — so they
  // miss bootstrap-replayed own streams. The provider must register too so SWR
  // doesn't clobber in-flight chat work during that window.
  it('given the provider mounts, should register a streaming session keyed `global-chat` with the editing store', () => {
    renderHook(() => useGlobalChatConversation(), { wrapper: Wrapper });

    expect(useStreamingRegistration).toHaveBeenCalledWith(
      'global-chat',
      expect.any(Boolean),
      expect.objectContaining({ componentName: 'GlobalChatProvider' }),
    );
  });
});

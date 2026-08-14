/**
 * useChannelStreamSocket is a ROUTER now, and this suite is scoped to that.
 *
 * WHAT THE OLD SUITE MOSTLY TESTED, AND WHY IT IS GONE.
 *
 * ~2200 lines, the bulk of it exercising a mount-scoped ownership protocol:
 * `claimBootstrapConsumer` deciding which of several co-mounted instances got to open the SSE
 * join, `channelStreamSubscribers` counting mounts so only the LAST one ran
 * `clearPageStreams`, `channelRebootstrapSignal` nudging a surviving sibling to re-adopt a
 * claim an unmounting one had dropped, and `shouldAttachStream`/`consumingChannels` stopping
 * the originating tab from joining its own multicast and double-rendering every token.
 *
 * Every one of those modules is deleted, and none of them is replaced. The subscription lives
 * at module scope in `streamSessionRegistry` now, so there is nothing to claim (it is the only
 * joiner), nothing to hand off (it never lets go), and nothing to count (a store entry's life
 * is the stream's life, not a mount's). Cases that pinned that protocol pinned a DEAD
 * mechanism and are deleted rather than ported — testing it would mean re-creating it.
 *
 * The registry's own behaviour — resumeFromSeq, poll fallback, end ordering, expiry — is
 * covered directly in `lib/ai/streams/__tests__/streamSessionRegistry.test.ts`. What is left
 * for THIS hook is: does it translate socket events and the DB bootstrap into the right
 * registry calls, does it answer "whose stream is this?" correctly, and — the leaf-2
 * requirement — does unmounting genuinely touch nothing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const LOCAL_USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const LOCAL_SESSION = 'session-current';
const OTHER_SESSION = 'session-other';
const CHANNEL = 'page-1';

const {
  mockSocket,
  mockFetchWithAuth,
  openStreamSession,
  completeStreamSession,
  closeChannelSessions,
  reconcileChannelSessions,
  endListeners,
} = vi.hoisted(() => {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    mockSocket: {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        (handlers[event] ??= []).push(handler);
      }),
      off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
      }),
      _trigger: (event: string, payload: unknown) => {
        handlers[event]?.slice().forEach((h) => h(payload));
      },
      _count: (event: string) => handlers[event]?.length ?? 0,
      _reset: () => Object.keys(handlers).forEach((k) => { handlers[k] = []; }),
    },
    mockFetchWithAuth: vi.fn(),
    openStreamSession: vi.fn(),
    completeStreamSession: vi.fn(),
    closeChannelSessions: vi.fn(),
    reconcileChannelSessions: vi.fn(),
    endListeners: new Set<(end: unknown) => void>(),
  };
});

vi.mock('@/hooks/useSocket', () => ({ useSocket: () => mockSocket }));

let mockAuthUserId: string | null = LOCAL_USER_ID;
vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ user: mockAuthUserId === null ? null : { id: mockAuthUserId } }),
  },
}));

let mockConnectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
vi.mock('@/stores/useSocketStore', () => ({
  useSocketStore: (selector: (s: { connectionStatus: string }) => unknown) =>
    selector({ connectionStatus: mockConnectionStatus }),
}));

vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: mockFetchWithAuth }));

vi.mock('@/lib/ai/core/browser-session-id', () => ({
  getBrowserSessionId: () => LOCAL_SESSION,
}));

// Every stub forwards ...args verbatim. An earlier version spelled out the parameters it
// happened to know about — `reconcileChannelSessions: (id, live) => spy(id, live)` — which
// silently DROPPED the conversation scope when that argument was added, so an assertion on the
// scope could never have failed. A mock that narrows the real signature is a mock that lies
// about the contract.
vi.mock('@/lib/ai/streams/streamSessionRegistry', () => ({
  openStreamSession: (...args: unknown[]) => openStreamSession(...args),
  completeStreamSession: (...args: unknown[]) => completeStreamSession(...args),
  closeChannelSessions: (...args: unknown[]) => closeChannelSessions(...args),
  reconcileChannelSessions: (...args: unknown[]) => reconcileChannelSessions(...args),
  onStreamSessionEnd: (listener: (end: unknown) => void) => {
    endListeners.add(listener);
    return () => endListeners.delete(listener);
  },
}));

import { useChannelStreamSocket } from '../useChannelStreamSocket';
import type {
  AiStreamStartPayload,
  AiStreamCompletePayload,
  ChatUserMessagePayload,
} from '@/lib/websocket/socket-utils';

const startPayload = (overrides: Partial<AiStreamStartPayload> = {}): AiStreamStartPayload =>
  ({
    messageId: 'msg-1',
    pageId: CHANNEL,
    conversationId: 'conv-1',
    startedAt: '2026-08-14T10:00:00.000Z',
    isShared: false,
    triggeredBy: {
      userId: LOCAL_USER_ID,
      displayName: 'Ada',
      browserSessionId: LOCAL_SESSION,
    },
    ...overrides,
  }) as AiStreamStartPayload;

const userMessagePayload = (browserSessionId: string, userId = LOCAL_USER_ID): ChatUserMessagePayload =>
  ({
    message: { id: 'u-1', role: 'user', parts: [] },
    pageId: CHANNEL,
    conversationId: 'conv-1',
    triggeredBy: { userId, displayName: 'Ada', browserSessionId },
  }) as ChatUserMessagePayload;

const mount = (options?: Parameters<typeof useChannelStreamSocket>[1], convId?: string | null) =>
  renderHook(() => useChannelStreamSocket(CHANNEL, options, convId));

beforeEach(() => {
  vi.clearAllMocks();
  mockSocket._reset();
  endListeners.clear();
  mockAuthUserId = LOCAL_USER_ID;
  mockConnectionStatus = 'disconnected';
  mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({ streams: [] }) });
});

describe('routing live events into the registry', () => {
  it('given a stream_start on this channel, opens a session with the STATED messageId', async () => {
    mount();
    await act(async () => {
      mockSocket._trigger('chat:stream_start', startPayload());
    });

    expect(openStreamSession).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-1',
        conversationId: 'conv-1',
        channelId: CHANNEL,
        startedAt: '2026-08-14T10:00:00.000Z',
      }),
    );
  });

  it('given a stream_start for a DIFFERENT channel, ignores it', async () => {
    mount();
    await act(async () => {
      mockSocket._trigger('chat:stream_start', startPayload({ pageId: 'other-page' }));
    });

    expect(openStreamSession).not.toHaveBeenCalled();
  });

  it('attaches without any "am I already consuming this?" gate', async () => {
    // That gate existed because the originating tab read its own tokens off the POST body, so
    // joining the multicast too rendered every token twice. Under detached mode nobody reads a
    // body: the sender's own send opens a session through the same idempotent registry, keyed
    // by the same messageId. One channel, one subscription, by construction.
    mount();
    await act(async () => {
      mockSocket._trigger('chat:stream_start', startPayload());
      mockSocket._trigger('chat:stream_start', startPayload());
    });

    // The hook forwards both; the REGISTRY dedups. That is the point — no bookkeeping here.
    expect(openStreamSession).toHaveBeenCalledTimes(2);
  });

  it('given a startedAt missing (old build), substitutes one so the entry can still age out', async () => {
    mount();
    await act(async () => {
      mockSocket._trigger('chat:stream_start', startPayload({ startedAt: undefined }));
    });

    const arg = openStreamSession.mock.calls[0][0] as { startedAt: string };
    expect(Number.isFinite(Date.parse(arg.startedAt))).toBe(true);
  });

  it('given a stream_complete, finalizes through the registry', async () => {
    mount();
    await act(async () => {
      mockSocket._trigger('chat:stream_complete', {
        messageId: 'msg-1',
        pageId: CHANNEL,
        conversationId: 'conv-1',
        aborted: true,
      } as AiStreamCompletePayload);
    });

    expect(completeStreamSession).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-1', channelId: CHANNEL, aborted: true }),
    );
  });
});

describe('whose stream is this — a USER question', () => {
  it('given the signed-in user\'s own stream, marks it own', async () => {
    mount();
    await act(async () => {
      mockSocket._trigger('chat:stream_start', startPayload());
    });

    expect(openStreamSession).toHaveBeenCalledWith(expect.objectContaining({ isOwn: true }));
  });

  it('given the SAME account from another tab or device, STILL marks it own', async () => {
    // The leaf-4 requirement. Keyed on `browserSessionId` this was false, so the second tab
    // rendered its own account's generation as a stranger's — no Stop button, attributed to
    // nobody.
    mount();
    await act(async () => {
      mockSocket._trigger(
        'chat:stream_start',
        startPayload({
          triggeredBy: {
            userId: LOCAL_USER_ID,
            displayName: 'Ada',
            browserSessionId: OTHER_SESSION,
          },
        }),
      );
    });

    expect(openStreamSession).toHaveBeenCalledWith(expect.objectContaining({ isOwn: true }));
  });

  it('given another MEMBER\'s stream on a shared page, never marks it own', async () => {
    mount();
    await act(async () => {
      mockSocket._trigger(
        'chat:stream_start',
        startPayload({
          triggeredBy: {
            userId: OTHER_USER_ID,
            displayName: 'Bob',
            browserSessionId: OTHER_SESSION,
          },
        }),
      );
    });

    expect(openStreamSession).toHaveBeenCalledWith(expect.objectContaining({ isOwn: false }));
  });

  it('given auth has not hydrated yet, fails closed rather than claiming the stream', async () => {
    // Read at EVENT time, not captured at effect time — a value captured on a fresh load would
    // be undefined for the first events and would classify the user's own stream as a
    // stranger's for the rest of the channel subscription.
    mockAuthUserId = null;
    mount();
    await act(async () => {
      mockSocket._trigger('chat:stream_start', startPayload());
    });

    expect(openStreamSession).toHaveBeenCalledWith(expect.objectContaining({ isOwn: false }));
  });

  it('given auth resolves AFTER mount, the next event sees the real identity', async () => {
    mockAuthUserId = null;
    mount();
    mockAuthUserId = LOCAL_USER_ID;

    await act(async () => {
      mockSocket._trigger('chat:stream_start', startPayload());
    });

    expect(openStreamSession).toHaveBeenCalledWith(expect.objectContaining({ isOwn: true }));
  });
});

describe('echo dedup is a TAB question', () => {
  it('given a user message this TAB caused, drops it as an echo', async () => {
    const onUserMessage = vi.fn();
    mount({ onUserMessage });

    await act(async () => {
      mockSocket._trigger('chat:user_message', userMessagePayload(LOCAL_SESSION));
    });

    expect(onUserMessage).not.toHaveBeenCalled();
  });

  it('given the SAME USER\'s other tab, still delivers it — that tab has not applied it', async () => {
    // The mirror-image error to the ownership one. Filtering this on `userId` would make the
    // user's other tab drop every event it needed and go quietly stale.
    const onUserMessage = vi.fn();
    mount({ onUserMessage });

    await act(async () => {
      mockSocket._trigger('chat:user_message', userMessagePayload(OTHER_SESSION, LOCAL_USER_ID));
    });

    expect(onUserMessage).toHaveBeenCalled();
  });

  it('given a global conversation added, delivers it even for this tab', async () => {
    // No own-tab filter: the history tab has no other signal.
    const onGlobalConversationAdded = vi.fn();
    mount({ onGlobalConversationAdded });

    await act(async () => {
      mockSocket._trigger('chat:global_conversation_added', {
        conversation: { id: 'c1' },
        triggeredBy: { userId: LOCAL_USER_ID, displayName: 'Ada', browserSessionId: LOCAL_SESSION },
      });
    });

    expect(onGlobalConversationAdded).toHaveBeenCalled();
  });
});

describe('bootstrap', () => {
  it('opens a session per in-flight row, seeded with its persisted snapshot', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({
        streams: [
          {
            messageId: 'msg-boot',
            conversationId: 'conv-boot',
            startedAt: '2026-08-14T09:00:00.000Z',
            parts: [{ type: 'text', text: 'restored' }],
            triggeredBy: {
              userId: LOCAL_USER_ID,
              displayName: 'Ada',
              browserSessionId: OTHER_SESSION,
            },
          },
        ],
      }),
    });

    mount();

    await waitFor(() =>
      expect(openStreamSession).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-boot',
          seedParts: [{ type: 'text', text: 'restored' }],
          // Bootstrapped from ANOTHER tab of the same account — still this user's own stream.
          isOwn: true,
        }),
      ),
    );
  });

  it('reconciles against the server\'s list of what is still live', async () => {
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({
        streams: [
          {
            messageId: 'msg-live',
            conversationId: 'conv-1',
            triggeredBy: { userId: LOCAL_USER_ID, displayName: 'Ada', browserSessionId: LOCAL_SESSION },
          },
        ],
      }),
    });

    mount();

    await waitFor(() =>
      expect(reconcileChannelSessions).toHaveBeenCalledWith(
        CHANNEL,
        new Set(['msg-live']),
        // No conversation narrowing here, but ALWAYS a snapshot time — a bootstrap's answer
        // cannot speak about a stream that started during its round trip.
        expect.objectContaining({ snapshotTakenAt: expect.any(Number) }),
      ),
    );
  });

  it('narrows the DB replay to one conversation when asked', async () => {
    mount(undefined, 'conv-scoped');

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
    expect(String(mockFetchWithAuth.mock.calls[0][0])).toContain('conversationId=conv-scoped');
  });

  it('reconciles with the SAME narrowing it bootstrapped with', async () => {
    // codex P1 on PR #2410. A scoped bootstrap lists one conversation's streams; passing that
    // narrow set to an UNSCOPED reconcile reads every sibling conversation on the channel as
    // finished, tearing down a live stream the request never even asked about.
    mount(undefined, 'conv-scoped');

    await waitFor(() => expect(reconcileChannelSessions).toHaveBeenCalled());
    expect(reconcileChannelSessions).toHaveBeenCalledWith(
      CHANNEL,
      expect.any(Set),
      expect.objectContaining({ conversationId: 'conv-scoped' }),
    );
  });

  it('given NO narrowing, reconciles channel-wide', async () => {
    // The provider's channel-wide subscription asks about everything, so its answer is
    // authoritative for everything.
    mount();

    await waitFor(() => expect(reconcileChannelSessions).toHaveBeenCalled());
    const scope = reconcileChannelSessions.mock.calls[0][2] as Record<string, unknown>;
    expect(scope).not.toHaveProperty('conversationId');
    expect(scope.snapshotTakenAt).toEqual(expect.any(Number));
  });

  it('given a failed bootstrap, does not reconcile — a missing answer is not "nothing is live"', async () => {
    mockFetchWithAuth.mockResolvedValue({ ok: false, json: async () => ({}) });
    mount();

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalled());
    expect(reconcileChannelSessions).not.toHaveBeenCalled();
  });

  it('re-runs on a socket reconnect, so events emitted while away are not lost', async () => {
    mockConnectionStatus = 'connected';
    const { rerender } = mount();
    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(1));

    mockConnectionStatus = 'disconnected';
    rerender();
    mockConnectionStatus = 'connected';
    rerender();

    await waitFor(() => expect(mockFetchWithAuth).toHaveBeenCalledTimes(2));
  });
});

describe('forwarding registry endings', () => {
  it('forwards an end for THIS channel', async () => {
    const onStreamComplete = vi.fn();
    mount({ onStreamComplete });

    act(() => {
      endListeners.forEach((l) =>
        l({ messageId: 'msg-1', conversationId: 'conv-1', channelId: CHANNEL, joinFailed: true, aborted: false }),
      );
    });

    expect(onStreamComplete).toHaveBeenCalledWith('msg-1', 'conv-1', { joinFailed: true }, false);
  });

  it('ignores an end for another channel', async () => {
    const onStreamComplete = vi.fn();
    mount({ onStreamComplete });

    act(() => {
      endListeners.forEach((l) =>
        l({ messageId: 'x', conversationId: 'c', channelId: 'elsewhere', joinFailed: false }),
      );
    });

    expect(onStreamComplete).not.toHaveBeenCalled();
  });
});

describe('unmount touches nothing — "send a message and leave"', () => {
  it('detaches socket listeners and does NOT tear down any stream', async () => {
    // The leaf-2 requirement, and the whole reason the subscription left the component tree.
    // The hook this replaces aborted every controller and ran `clearPageStreams(channelId)` on
    // unmount, so closing a pane killed the reads.
    const { unmount } = mount();
    await act(async () => {
      mockSocket._trigger('chat:stream_start', startPayload());
    });

    unmount();

    expect(closeChannelSessions, 'unmount is not a revocation').not.toHaveBeenCalled();
    expect(completeStreamSession, 'unmount is not a completion').not.toHaveBeenCalled();
    // Listeners ARE detached — that is the only thing a mount owned.
    expect(mockSocket._count('chat:stream_start')).toBe(0);
    expect(mockSocket._count('access_revoked')).toBe(0);
  });

  it('given TWO co-mounted instances and one unmounts, the other keeps receiving', async () => {
    // No subscriber counting, no claim handoff, no sibling nudge. Agent panes routinely
    // co-mount several instances on one channelId; the surviving one simply still has its
    // listener attached.
    const first = mount();
    const second = mount();

    first.unmount();
    await act(async () => {
      mockSocket._trigger('chat:stream_start', startPayload());
    });

    expect(openStreamSession).toHaveBeenCalledTimes(1);
    second.unmount();
  });
});

describe('access revocation IS a teardown', () => {
  it('closes the channel\'s sessions without reporting completions', async () => {
    // Nothing finished — telling consumers otherwise would have them reload messages the user
    // may no longer read.
    const onStreamComplete = vi.fn();
    mount({ onStreamComplete });

    await act(async () => {
      mockSocket._trigger('access_revoked', { room: CHANNEL });
    });

    expect(closeChannelSessions).toHaveBeenCalledWith(CHANNEL);
    expect(onStreamComplete).not.toHaveBeenCalled();
  });

  it('ignores a revocation for another room', async () => {
    mount();
    await act(async () => {
      mockSocket._trigger('access_revoked', { room: 'somewhere-else' });
    });

    expect(closeChannelSessions).not.toHaveBeenCalled();
  });
});

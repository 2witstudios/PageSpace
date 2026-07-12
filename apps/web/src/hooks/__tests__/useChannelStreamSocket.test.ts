import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------
const SESSION_ID_LOCAL = 'session-current';
const SESSION_ID_REMOTE = 'session-other';

const {
  mockSocket,
  mockAddStream,
  mockAppendPart,
  mockRemoveStream,
  mockClearPageStreams,
  mockConsumeStreamJoin,
  mockFetchWithAuth,
  mockGetBrowserSessionId,
} = vi.hoisted(() => {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

  const mockSocket = {
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
  };

  const mockAddStream = vi.fn();
  const mockAppendPart = vi.fn();
  const mockRemoveStream = vi.fn();
  const mockClearPageStreams = vi.fn();
  const mockConsumeStreamJoin = vi.fn().mockResolvedValue({ aborted: false });
  const mockFetchWithAuth = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ streams: [] }),
  });
  const mockGetBrowserSessionId = vi.fn(() => 'session-current');

  return {
    mockSocket,
    mockAddStream,
    mockAppendPart,
    mockRemoveStream,
    mockClearPageStreams,
    mockConsumeStreamJoin,
    mockFetchWithAuth,
    mockGetBrowserSessionId,
  };
});

vi.mock('@/hooks/useSocket', () => ({
  useSocket: () => mockSocket,
}));

const LOCAL_USER_ID = 'user-1';
let mockAuthUserId: string | null = LOCAL_USER_ID;
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: mockAuthUserId === null ? null : { id: mockAuthUserId } }),
}));

let mockConnectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';
vi.mock('@/stores/useSocketStore', () => ({
  useSocketStore: (selector: (s: { connectionStatus: string }) => unknown) =>
    selector({ connectionStatus: mockConnectionStatus }),
}));

vi.mock('@/stores/usePendingStreamsStore', () => ({
  usePendingStreamsStore: {
    getState: () => ({
      addStream: mockAddStream,
      appendPart: mockAppendPart,
      removeStream: mockRemoveStream,
      clearPageStreams: mockClearPageStreams,
    }),
  },
}));

vi.mock('@/lib/ai/core/stream-join-client', () => ({
  consumeStreamJoin: mockConsumeStreamJoin,
}));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
}));

vi.mock('@/lib/ai/core/browser-session-id', () => ({
  getBrowserSessionId: mockGetBrowserSessionId,
}));

vi.mock('@/lib/ai/streams/bootstrapConsumerGuard', () => ({
  claimBootstrapConsumer: vi.fn(() => true),
  releaseBootstrapConsumer: vi.fn(),
}));

import { useChannelStreamSocket } from '../useChannelStreamSocket';
import { releaseBootstrapConsumer } from '@/lib/ai/streams/bootstrapConsumerGuard';
import { markChannelConsuming, resetConsumingChannels } from '@/lib/ai/streams/consumingChannels';
import type {
  AiStreamStartPayload,
  AiStreamCompletePayload,
  ChatUserMessagePayload,
  ChatMessageEditedPayload,
  ChatMessageDeletedPayload,
  ChatUndoAppliedPayload,
  ChatConversationAddedPayload,
  ChatGlobalConversationAddedPayload,
} from '@/lib/websocket/socket-utils';

const START_PAYLOAD: AiStreamStartPayload = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
  startedAt: '2024-01-01T00:00:00.000Z',
  triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
};

const COMPLETE_PAYLOAD: AiStreamCompletePayload = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
};

const USER_MESSAGE_PAYLOAD: ChatUserMessagePayload = {
  message: { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
  pageId: 'page-a',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
};

const MESSAGE_EDITED_PAYLOAD: ChatMessageEditedPayload = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
  parts: [{ type: 'text', text: 'updated' }],
  editedAt: '2026-05-01T00:00:00.000Z',
  triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
};

const MESSAGE_DELETED_PAYLOAD: ChatMessageDeletedPayload = {
  messageId: 'msg-1',
  pageId: 'page-a',
  conversationId: 'conv-1',
  triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
};

const UNDO_APPLIED_PAYLOAD: ChatUndoAppliedPayload = {
  conversationId: 'conv-1',
  pageId: 'page-a',
  mode: 'messages_and_changes',
  affectedMessageIds: ['msg-1', 'msg-2'],
  triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
};

const CONVERSATION_ADDED_PAYLOAD: ChatConversationAddedPayload = {
  agentId: 'page-a',
  conversation: {
    id: 'conv-new',
    title: 'New conversation',
    createdAt: '2026-05-01T00:00:00.000Z',
  },
  triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
};

const GLOBAL_CONVERSATION_ADDED_PAYLOAD: ChatGlobalConversationAddedPayload = {
  conversation: {
    id: 'conv-global-1',
    title: 'My first chat',
    type: 'global',
    createdAt: '2026-05-01T00:00:00.000Z',
  },
  triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_REMOTE },
};

describe('useChannelStreamSocket', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket._reset();
    // Module state — a real reload clears it; a test file must too.
    resetConsumingChannels();
    mockConnectionStatus = 'disconnected';
    mockAuthUserId = LOCAL_USER_ID;
    mockConsumeStreamJoin.mockResolvedValue({ aborted: false });
    mockGetBrowserSessionId.mockReturnValue(SESSION_ID_LOCAL);
    mockFetchWithAuth.mockResolvedValue({
      ok: true,
      json: async () => ({ streams: [] }),
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('chat:stream_start from another user', () => {
    it('should call addStream and start consumeStreamJoin', () => {
      renderHook(() => useChannelStreamSocket('page-a'));

      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      expect(mockAddStream).toHaveBeenCalledWith({
        messageId: 'msg-1',
        pageId: 'page-a',
        conversationId: 'conv-1',
        triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
        isOwn: false,
        startedAt: '2024-01-01T00:00:00.000Z',
      });
      expect(mockConsumeStreamJoin).toHaveBeenCalledWith(
        'msg-1',
        expect.any(AbortSignal),
        expect.any(Function),
      );
    });

    it('should wire onChunk to appendPart in the store', async () => {
      let capturedOnChunk!: (part: unknown) => void;
      mockConsumeStreamJoin.mockImplementation(
        (_id: string, _signal: AbortSignal, onChunk: (part: unknown) => void) => {
          capturedOnChunk = onChunk;
          return new Promise(() => {}); // never resolves
        },
      );

      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      const textPart = { type: 'text', text: 'hello' };
      capturedOnChunk(textPart);
      expect(mockAppendPart).toHaveBeenCalledWith('msg-1', textPart);
    });

    it('should call removeStream and onStreamComplete after consumeStreamJoin resolves', async () => {
      let resolveJoin!: () => void;
      // A successful join to a live stream always delivers at least the buffered prefix (the SSE
      // route replays it synchronously on subscribe). A join that delivers NOTHING means our copy
      // is not authoritative — the hook now reports joinFailed so consumers reload from the DB
      // rather than rendering the stale, debounced seed. Model the delivery.
      mockConsumeStreamJoin.mockImplementation(
        (_id: string, _signal: AbortSignal, onChunk: (part: unknown) => void) =>
          new Promise<{ aborted: boolean }>((res) => {
            resolveJoin = () => {
              onChunk({ type: 'text', text: 'hello' });
              res({ aborted: false });
            };
          }),
      );
      const onStreamComplete = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      await act(async () => { resolveJoin(); });

      expect(mockRemoveStream).toHaveBeenCalledWith('msg-1');
      expect(onStreamComplete).toHaveBeenCalledWith('msg-1', 'conv-1', { joinFailed: false });
    });

    it('should call onStreamComplete before removeStream so stream data is available in the callback (SSE path)', async () => {
      let resolveJoin!: () => void;
      // A real join DELIVERS at least one part — that is how the store gets the data this test is
      // about. A join that delivers nothing leaves only the seeded (debounced, possibly shorter)
      // DB snapshot, which is not authoritative, so the hook now drops it and lets consumers
      // reload from the DB instead of rendering a truncated bubble.
      mockConsumeStreamJoin.mockImplementation(
        (_id: string, _signal: AbortSignal, onChunk: (part: unknown) => void) =>
          new Promise<{ aborted: boolean }>((res) => {
            resolveJoin = () => {
              onChunk({ type: 'text', text: 'hello' });
              res({ aborted: false });
            };
          }),
      );
      const callOrder: string[] = [];
      mockRemoveStream.mockImplementation(() => { callOrder.push('removeStream'); });
      const onStreamComplete = vi.fn(() => { callOrder.push('onStreamComplete'); });

      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      await act(async () => { resolveJoin(); });

      expect(callOrder).toEqual(['onStreamComplete', 'removeStream']);
    });
  });

  describe('SSE join error', () => {
    it('given consumeStreamJoin rejects, should call removeStream to prevent stale store entry', async () => {
      mockConsumeStreamJoin.mockRejectedValue(new Error('network error'));

      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      await act(async () => { await Promise.resolve(); });

      expect(mockRemoveStream).toHaveBeenCalledWith('msg-1');
    });
  });

  describe('chat:stream_start from local browser session', () => {
    it('given an own-session stream this context is CONSUMING over the POST body, should skip addStream and consumeStreamJoin (no double-render)', () => {
      const localPayload: AiStreamStartPayload = {
        ...START_PAYLOAD,
        triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
      };

      markChannelConsuming('page-a');
      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', localPayload); });

      expect(mockAddStream).not.toHaveBeenCalled();
      expect(mockConsumeStreamJoin).not.toHaveBeenCalled();
    });

    // THE HEADLINE REGRESSION TEST. A reload wipes the consuming set (module state)
    // but NOT the browserSessionId (sessionStorage). Under the old blanket own-session
    // skip, the reloaded tab still looked like the originator and dropped its own
    // stream forever: no bubble, no Stop button, live input, while the server kept
    // generating and editing pages.
    it('given an own-session stream this context is NOT consuming (i.e. after a reload), should attach to it like any other subscriber', () => {
      const localPayload: AiStreamStartPayload = {
        ...START_PAYLOAD,
        triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
      };

      // The consuming set is empty — exactly the state a freshly-loaded document is in.
      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', localPayload); });

      expect(mockAddStream).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'msg-1',
        isOwn: true,
      }));
      expect(mockConsumeStreamJoin).toHaveBeenCalledTimes(1);
    });

    it('given a REMOTE stream while this context is consuming its own on the same channel, should still attach (multiplayer is not collateral damage)', () => {
      markChannelConsuming('page-a');
      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      expect(mockAddStream).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'msg-1',
        isOwn: false,
      }));
      expect(mockConsumeStreamJoin).toHaveBeenCalledTimes(1);
    });

    it('given an own-session stream after a reload, should fire onOwnStreamBootstrap so the Stop button comes back', () => {
      const onOwnStreamBootstrap = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamBootstrap }));

      act(() => {
        mockSocket._trigger('chat:stream_start', {
          ...START_PAYLOAD,
          triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
        });
      });

      expect(onOwnStreamBootstrap).toHaveBeenCalledWith({ messageId: 'msg-1', conversationId: 'conv-1' });
    });

    it('given triggeredBy.userId matches local user but browserSessionId differs, should still addStream (cross-session same-user)', () => {
      const otherSessionSameUser: AiStreamStartPayload = {
        ...START_PAYLOAD,
        triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_REMOTE },
      };

      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', otherSessionSameUser); });

      expect(mockAddStream).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'msg-1',
        isOwn: false,
        startedAt: '2024-01-01T00:00:00.000Z',
      }));
    });
  });

  // A page room holds every member of the page, but conversations are private by default
  // (`listConversations` shows you only `userId = you OR isShared`). The server refuses
  // these joins anyway; skipping them client-side is what stops every member firing a
  // doomed /stream-join per assistant message — each one an authz denial in the audit log.
  describe('chat:stream_start — conversation privacy pre-filter', () => {
    it("given another user's stream in a PRIVATE conversation, should not attach or even attempt the join", () => {
      renderHook(() => useChannelStreamSocket('page-a'));

      act(() => {
        mockSocket._trigger('chat:stream_start', {
          ...START_PAYLOAD,
          isShared: false,
          triggeredBy: { userId: 'user-other', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
        });
      });

      expect(mockAddStream).not.toHaveBeenCalled();
      expect(mockConsumeStreamJoin).not.toHaveBeenCalled();
    });

    it("given another user's stream in an explicitly SHARED conversation, should attach (multiplayer)", () => {
      renderHook(() => useChannelStreamSocket('page-a'));

      act(() => {
        mockSocket._trigger('chat:stream_start', {
          ...START_PAYLOAD,
          isShared: true,
          triggeredBy: { userId: 'user-other', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
        });
      });

      expect(mockAddStream).toHaveBeenCalled();
      expect(mockConsumeStreamJoin).toHaveBeenCalledTimes(1);
    });

    // The same user in a second tab: a different browserSessionId, so `isOwn` is false —
    // but it is still THEIR stream and their private conversation. They must see it.
    it('given MY OWN stream from another tab in a private conversation, should still attach', () => {
      renderHook(() => useChannelStreamSocket('page-a'));

      act(() => {
        mockSocket._trigger('chat:stream_start', {
          ...START_PAYLOAD,
          isShared: false,
          triggeredBy: { userId: LOCAL_USER_ID, displayName: 'Me', browserSessionId: 'a-different-tab' },
        });
      });

      expect(mockAddStream).toHaveBeenCalled();
      expect(mockConsumeStreamJoin).toHaveBeenCalledTimes(1);
    });

    // `useAuth()` returns `user: null` until auth resolves. Treating "I don't know who I
    // am" as "not me" would drop the user's OWN private stream in that window — the exact
    // failure this whole PR exists to fix. Skip only on certainty; when in doubt, attach
    // and let the server decide (an unauthorized join is a quiet 404).
    it('given the signed-in user is not known yet, should NOT drop a private stream (it may be the user\'s own)', () => {
      mockAuthUserId = null;
      renderHook(() => useChannelStreamSocket('page-a'));

      act(() => {
        mockSocket._trigger('chat:stream_start', {
          ...START_PAYLOAD,
          isShared: false,
          triggeredBy: { userId: LOCAL_USER_ID, displayName: 'Me', browserSessionId: 'another-tab' },
        });
      });

      expect(mockAddStream).toHaveBeenCalled();
      expect(mockConsumeStreamJoin).toHaveBeenCalledTimes(1);
    });

    // Rolling deploy: an originator on the previous build emits no `isShared` field.
    // Dropping on `undefined` would black out multiplayer for shared conversations
    // mid-deploy, so only an explicit `false` skips. The server is the authority anyway.
    it('given no isShared field at all (old server, rolling deploy), should attempt the join rather than drop it', () => {
      renderHook(() => useChannelStreamSocket('page-a'));

      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      expect(mockAddStream).toHaveBeenCalled();
      expect(mockConsumeStreamJoin).toHaveBeenCalledTimes(1);
    });
  });

  // A1 — pageId guard
  describe('chat:user_message', () => {
    it('given a chat:user_message from another user for the current channel, should call onUserMessage with the message payload', () => {
      const onUserMessage = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onUserMessage }));

      act(() => { mockSocket._trigger('chat:user_message', USER_MESSAGE_PAYLOAD); });

      expect(onUserMessage).toHaveBeenCalledTimes(1);
      expect(onUserMessage).toHaveBeenCalledWith(USER_MESSAGE_PAYLOAD.message, USER_MESSAGE_PAYLOAD);
    });

    it('given chat:user_message with a different pageId, should NOT call onUserMessage (stale-room guard)', () => {
      const onUserMessage = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onUserMessage }));

      act(() => {
        mockSocket._trigger('chat:user_message', { ...USER_MESSAGE_PAYLOAD, pageId: 'page-b' });
      });

      expect(onUserMessage).not.toHaveBeenCalled();
    });

    it('given chat:user_message whose triggeredBy.browserSessionId matches the local session, should NOT call onUserMessage (own-tab dedup)', () => {
      const onUserMessage = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onUserMessage }));

      act(() => {
        mockSocket._trigger('chat:user_message', {
          ...USER_MESSAGE_PAYLOAD,
          triggeredBy: { ...USER_MESSAGE_PAYLOAD.triggeredBy, browserSessionId: SESSION_ID_LOCAL },
        });
      });

      expect(onUserMessage).not.toHaveBeenCalled();
    });

    it('given the socket reconnects, should keep the chat:user_message handler registered', () => {
      const onUserMessage = vi.fn();
      const { rerender } = renderHook(({ id }) => useChannelStreamSocket(id, { onUserMessage }), {
        initialProps: { id: 'page-a' as string | undefined },
      });

      // Re-render to a different channel and back — exercises the listener re-registration path.
      rerender({ id: 'page-b' });
      rerender({ id: 'page-a' });

      act(() => { mockSocket._trigger('chat:user_message', USER_MESSAGE_PAYLOAD); });

      expect(onUserMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('chat:message_edited', () => {
    it('given a chat:message_edited from another tab for the current channel, should call onMessageEdited with the payload', () => {
      const onMessageEdited = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onMessageEdited }));

      act(() => { mockSocket._trigger('chat:message_edited', MESSAGE_EDITED_PAYLOAD); });

      expect(onMessageEdited).toHaveBeenCalledTimes(1);
      expect(onMessageEdited).toHaveBeenCalledWith(MESSAGE_EDITED_PAYLOAD);
    });

    it('given chat:message_edited with a different pageId, should NOT call onMessageEdited (stale-room guard)', () => {
      const onMessageEdited = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onMessageEdited }));

      act(() => {
        mockSocket._trigger('chat:message_edited', { ...MESSAGE_EDITED_PAYLOAD, pageId: 'page-b' });
      });

      expect(onMessageEdited).not.toHaveBeenCalled();
    });

    it('given chat:message_edited whose triggeredBy.browserSessionId matches the local session, should NOT call onMessageEdited (own-tab dedup)', () => {
      const onMessageEdited = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onMessageEdited }));

      act(() => {
        mockSocket._trigger('chat:message_edited', {
          ...MESSAGE_EDITED_PAYLOAD,
          triggeredBy: { ...MESSAGE_EDITED_PAYLOAD.triggeredBy, browserSessionId: SESSION_ID_LOCAL },
        });
      });

      expect(onMessageEdited).not.toHaveBeenCalled();
    });

    it('given onMessageEdited reference changes between renders, should invoke the latest callback', () => {
      let callback = vi.fn();
      const { rerender } = renderHook(() => useChannelStreamSocket('page-a', { onMessageEdited: callback }));

      const second = vi.fn();
      callback = second;
      rerender();

      act(() => { mockSocket._trigger('chat:message_edited', MESSAGE_EDITED_PAYLOAD); });

      expect(second).toHaveBeenCalledWith(MESSAGE_EDITED_PAYLOAD);
    });
  });

  describe('chat:message_deleted', () => {
    it('given a chat:message_deleted from another tab for the current channel, should call onMessageDeleted with the payload', () => {
      const onMessageDeleted = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onMessageDeleted }));

      act(() => { mockSocket._trigger('chat:message_deleted', MESSAGE_DELETED_PAYLOAD); });

      expect(onMessageDeleted).toHaveBeenCalledTimes(1);
      expect(onMessageDeleted).toHaveBeenCalledWith(MESSAGE_DELETED_PAYLOAD);
    });

    it('given chat:message_deleted with a different pageId, should NOT call onMessageDeleted (stale-room guard)', () => {
      const onMessageDeleted = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onMessageDeleted }));

      act(() => {
        mockSocket._trigger('chat:message_deleted', { ...MESSAGE_DELETED_PAYLOAD, pageId: 'page-b' });
      });

      expect(onMessageDeleted).not.toHaveBeenCalled();
    });

    it('given chat:message_deleted whose triggeredBy.browserSessionId matches the local session, should NOT call onMessageDeleted (own-tab dedup)', () => {
      const onMessageDeleted = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onMessageDeleted }));

      act(() => {
        mockSocket._trigger('chat:message_deleted', {
          ...MESSAGE_DELETED_PAYLOAD,
          triggeredBy: { ...MESSAGE_DELETED_PAYLOAD.triggeredBy, browserSessionId: SESSION_ID_LOCAL },
        });
      });

      expect(onMessageDeleted).not.toHaveBeenCalled();
    });

    it('given the hook unmounts, should remove the chat:message_deleted listener', () => {
      const onMessageDeleted = vi.fn();
      const { unmount } = renderHook(() => useChannelStreamSocket('page-a', { onMessageDeleted }));

      unmount();
      act(() => { mockSocket._trigger('chat:message_deleted', MESSAGE_DELETED_PAYLOAD); });

      expect(onMessageDeleted).not.toHaveBeenCalled();
    });
  });

  describe('chat:undo_applied', () => {
    it('given a chat:undo_applied from another tab for the current channel, should call onUndoApplied with the payload', () => {
      const onUndoApplied = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onUndoApplied }));

      act(() => { mockSocket._trigger('chat:undo_applied', UNDO_APPLIED_PAYLOAD); });

      expect(onUndoApplied).toHaveBeenCalledTimes(1);
      expect(onUndoApplied).toHaveBeenCalledWith(UNDO_APPLIED_PAYLOAD);
    });

    it('given chat:undo_applied with a different pageId, should NOT call onUndoApplied (stale-room guard)', () => {
      const onUndoApplied = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onUndoApplied }));

      act(() => {
        mockSocket._trigger('chat:undo_applied', { ...UNDO_APPLIED_PAYLOAD, pageId: 'page-b' });
      });

      expect(onUndoApplied).not.toHaveBeenCalled();
    });

    it('given chat:undo_applied whose triggeredBy.browserSessionId matches the local session, should NOT call onUndoApplied (own-tab dedup)', () => {
      const onUndoApplied = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onUndoApplied }));

      act(() => {
        mockSocket._trigger('chat:undo_applied', {
          ...UNDO_APPLIED_PAYLOAD,
          triggeredBy: { ...UNDO_APPLIED_PAYLOAD.triggeredBy, browserSessionId: SESSION_ID_LOCAL },
        });
      });

      expect(onUndoApplied).not.toHaveBeenCalled();
    });
  });

  describe('chat:conversation_added', () => {
    it('given a chat:conversation_added from another tab for the current agent room, should call onConversationAdded with the payload', () => {
      const onConversationAdded = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onConversationAdded }));

      act(() => { mockSocket._trigger('chat:conversation_added', CONVERSATION_ADDED_PAYLOAD); });

      expect(onConversationAdded).toHaveBeenCalledTimes(1);
      expect(onConversationAdded).toHaveBeenCalledWith(CONVERSATION_ADDED_PAYLOAD);
    });

    it('given chat:conversation_added with a different agentId, should NOT call onConversationAdded (stale-room guard)', () => {
      const onConversationAdded = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onConversationAdded }));

      act(() => {
        mockSocket._trigger('chat:conversation_added', { ...CONVERSATION_ADDED_PAYLOAD, agentId: 'page-b' });
      });

      expect(onConversationAdded).not.toHaveBeenCalled();
    });

    it('given chat:conversation_added whose triggeredBy.browserSessionId matches the local session, should NOT call onConversationAdded (own-tab dedup)', () => {
      const onConversationAdded = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onConversationAdded }));

      act(() => {
        mockSocket._trigger('chat:conversation_added', {
          ...CONVERSATION_ADDED_PAYLOAD,
          triggeredBy: { ...CONVERSATION_ADDED_PAYLOAD.triggeredBy, browserSessionId: SESSION_ID_LOCAL },
        });
      });

      expect(onConversationAdded).not.toHaveBeenCalled();
    });
  });

  describe('chat:global_conversation_added', () => {
    it('given a chat:global_conversation_added event, should call onGlobalConversationAdded with the payload', () => {
      const onGlobalConversationAdded = vi.fn();
      renderHook(() => useChannelStreamSocket('user:u1:global', { onGlobalConversationAdded }));

      act(() => { mockSocket._trigger('chat:global_conversation_added', GLOBAL_CONVERSATION_ADDED_PAYLOAD); });

      expect(onGlobalConversationAdded).toHaveBeenCalledTimes(1);
      expect(onGlobalConversationAdded).toHaveBeenCalledWith(GLOBAL_CONVERSATION_ADDED_PAYLOAD);
    });

    it('given own-session triggeredBy, should STILL call onGlobalConversationAdded (no own-tab dedup)', () => {
      const onGlobalConversationAdded = vi.fn();
      renderHook(() => useChannelStreamSocket('user:u1:global', { onGlobalConversationAdded }));

      act(() => {
        mockSocket._trigger('chat:global_conversation_added', {
          ...GLOBAL_CONVERSATION_ADDED_PAYLOAD,
          triggeredBy: { ...GLOBAL_CONVERSATION_ADDED_PAYLOAD.triggeredBy, browserSessionId: SESSION_ID_LOCAL },
        });
      });

      expect(onGlobalConversationAdded).toHaveBeenCalledTimes(1);
    });
  });

  describe('pageId guard', () => {
    it('given chat:stream_start with a different pageId, should ignore the event', () => {
      renderHook(() => useChannelStreamSocket('page-a'));

      act(() => {
        mockSocket._trigger('chat:stream_start', { ...START_PAYLOAD, pageId: 'page-b' });
      });

      expect(mockAddStream).not.toHaveBeenCalled();
      expect(mockConsumeStreamJoin).not.toHaveBeenCalled();
    });

    it('given chat:stream_complete with a different pageId, should ignore the event', () => {
      const onStreamComplete = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));

      act(() => {
        mockSocket._trigger('chat:stream_complete', { ...COMPLETE_PAYLOAD, pageId: 'page-b' });
      });

      expect(mockRemoveStream).not.toHaveBeenCalled();
      expect(onStreamComplete).not.toHaveBeenCalled();
    });
  });

  describe('chat:stream_complete', () => {
    it('should call removeStream and onStreamComplete, reporting joinFailed for a stream we never joined', () => {
      const onStreamComplete = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));

      // No stream_start, no join: we hold no authoritative copy of this stream, so `joinFailed`
      // is TRUE — that flag means "our parts are not the source of truth, reload from the DB",
      // not "the network failed". Consumers behave identically either way here (there is no store
      // entry, so they take the reload branch regardless); the flag now simply tells the truth.
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(mockRemoveStream).toHaveBeenCalledWith('msg-1');
      expect(onStreamComplete).toHaveBeenCalledWith('msg-1', 'conv-1', { joinFailed: true });
    });

    it('should call onStreamComplete before removeStream so stream data is available in the callback (socket path)', async () => {
      const callOrder: string[] = [];
      // The stream must actually have been joined AND delivered content — otherwise there is no
      // "stream data" for the callback to see, and the hook deliberately drops the entry so
      // consumers reload the authoritative message from the DB.
      let deliver!: () => void;
      mockConsumeStreamJoin.mockImplementation(
        (_id: string, _signal: AbortSignal, onChunk: (part: unknown) => void) =>
          new Promise<{ aborted: boolean }>(() => {
            deliver = () => onChunk({ type: 'text', text: 'hello' });
          }),
      );
      const onStreamComplete = vi.fn(() => { callOrder.push('onStreamComplete'); });

      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });
      await act(async () => { await Promise.resolve(); deliver(); });

      mockRemoveStream.mockImplementation(() => { callOrder.push('removeStream'); });
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(callOrder).toEqual(['onStreamComplete', 'removeStream']);
    });

    it('should abort the in-flight controller if one exists', async () => {
      let capturedSignal!: AbortSignal;
      mockConsumeStreamJoin.mockImplementation(
        (_id: string, signal: AbortSignal) => {
          capturedSignal = signal;
          return new Promise(() => {}); // never resolves
        },
      );

      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(capturedSignal.aborted).toBe(true);
    });
  });

  // A2 — double onStreamComplete prevention
  describe('onStreamComplete deduplication', () => {
    it('given SSE done sentinel resolves and chat:stream_complete also fires, should call onStreamComplete exactly once', async () => {
      let resolveJoin!: () => void;
      mockConsumeStreamJoin.mockReturnValue(
        new Promise<{ aborted: boolean }>((res) => { resolveJoin = () => res({ aborted: false }); }),
      );
      const onStreamComplete = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      // SSE done resolves first
      await act(async () => { resolveJoin(); });

      // Then socket stream_complete also fires
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    it('given chat:stream_complete fires before SSE resolves, should call onStreamComplete exactly once', async () => {
      mockConsumeStreamJoin.mockReturnValue(new Promise(() => {})); // never resolves naturally
      const onStreamComplete = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      // stream_complete fires (aborts the SSE join)
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      // Give any pending promise chains a tick to settle
      await act(async () => { await Promise.resolve(); });

      expect(onStreamComplete).toHaveBeenCalledTimes(1);
    });

    // A failed SSE join does NOT mean the stream failed — the usual cause is that it
    // is owned by another web instance, whose in-process multicast registry we can't
    // reach. It keeps generating and it still broadcasts chat:stream_complete. Under
    // the old behaviour that event was suppressed, so the ghost vanished and the
    // finished (durably persisted) assistant message was never loaded.
    it('given SSE rejects then chat:stream_complete fires, should call onStreamComplete with the store entry ALREADY removed, so the surface reloads from the DB', async () => {
      let rejectJoin!: (err: Error) => void;
      mockConsumeStreamJoin.mockReturnValueOnce(
        new Promise((_res, rej) => { rejectJoin = rej; }),
      );
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const onStreamComplete = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      await act(async () => { rejectJoin(new Error('network down')); await Promise.resolve(); });

      mockRemoveStream.mockClear();
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(onStreamComplete).toHaveBeenCalledWith('msg-1', 'conv-1', { joinFailed: true });
      // Removed BEFORE the callback fired: shouldReloadOnComountComplete keys on the
      // absence of a store entry to choose the reload-from-DB branch over synthesizing
      // a bubble from what is, at best, a stale snapshot.
      expect(mockRemoveStream).toHaveBeenCalledWith('msg-1');
      errorSpy.mockRestore();
    });

    it('given SSE resolves after unmount via aborted controller, should NOT call onStreamComplete', async () => {
      let resolveJoin!: () => void;
      mockConsumeStreamJoin.mockReturnValue(
        new Promise<{ aborted: boolean }>((res) => { resolveJoin = () => res({ aborted: false }); }),
      );
      const onStreamComplete = vi.fn();

      const { unmount } = renderHook(() =>
        useChannelStreamSocket('page-a', { onStreamComplete }),
      );
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      unmount();

      await act(async () => { resolveJoin(); await Promise.resolve(); });

      expect(onStreamComplete).not.toHaveBeenCalled();
    });
  });

  // A3 — callback ref: onStreamComplete change should not re-register handlers
  describe('onStreamComplete stability', () => {
    it('given onStreamComplete reference changes between renders, should not re-register socket handlers', () => {
      let callback = vi.fn();
      const { rerender } = renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete: callback }));

      const onCallCount = mockSocket.on.mock.calls.length;

      callback = vi.fn(); // new reference
      rerender();

      expect(mockSocket.on.mock.calls.length).toBe(onCallCount);
    });

    it('given onStreamComplete reference changes between renders, should invoke the latest callback', async () => {
      let resolveJoin!: () => void;
      mockConsumeStreamJoin.mockReturnValue(
        new Promise<{ aborted: boolean }>((res) => { resolveJoin = () => res({ aborted: false }); }),
      );

      const firstCallback = vi.fn();
      let callback = firstCallback;
      const { rerender } = renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete: callback }));

      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      // Swap callback before stream resolves
      const secondCallback = vi.fn();
      callback = secondCallback;
      rerender();

      await act(async () => { resolveJoin(); });

      expect(firstCallback).not.toHaveBeenCalled();
      expect(secondCallback).toHaveBeenCalledWith('msg-1', 'conv-1', { joinFailed: false });
    });
  });

  describe('access_revoked', () => {
    it('given access_revoked for the current channel, should abort the open controller and call clearPageStreams', () => {
      let capturedSignal!: AbortSignal;
      mockConsumeStreamJoin.mockImplementation(
        (_id: string, signal: AbortSignal) => {
          capturedSignal = signal;
          return new Promise(() => {}); // never resolves
        },
      );

      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      act(() => { mockSocket._trigger('access_revoked', { room: 'page-a', reason: 'permission_revoked' }); });

      expect(capturedSignal.aborted).toBe(true);
      expect(mockClearPageStreams).toHaveBeenCalledWith('page-a');
    });

    it('given access_revoked for a different room, should NOT abort the controller or clear this channel', () => {
      let capturedSignal!: AbortSignal;
      mockConsumeStreamJoin.mockImplementation(
        (_id: string, signal: AbortSignal) => {
          capturedSignal = signal;
          return new Promise(() => {}); // never resolves
        },
      );

      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      act(() => { mockSocket._trigger('access_revoked', { room: 'page-b', reason: 'permission_revoked' }); });

      expect(capturedSignal.aborted).toBe(false);
      expect(mockClearPageStreams).not.toHaveBeenCalledWith('page-a');
    });

    it('given access_revoked fires and the aborted consumeStreamJoin promise later resolves, should NOT call onStreamComplete or onOwnStreamFinalize (revocation is not a clean finish)', async () => {
      let resolveJoin!: (v: { aborted: boolean }) => void;
      mockConsumeStreamJoin.mockReturnValue(
        new Promise<{ aborted: boolean }>((res) => { resolveJoin = res; }),
      );
      const onStreamComplete = vi.fn();
      const onOwnStreamFinalize = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete, onOwnStreamFinalize }));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      act(() => { mockSocket._trigger('access_revoked', { room: 'page-a', reason: 'permission_revoked' }); });

      // The abort propagates through consumeStreamJoin as a resolved (not rejected) promise.
      await act(async () => { resolveJoin({ aborted: true }); });

      expect(onStreamComplete).not.toHaveBeenCalled();
      expect(onOwnStreamFinalize).not.toHaveBeenCalled();
    });

    it('given access_revoked for the current channel, should release the bootstrap consumer guard for each aborted controller', () => {
      mockConsumeStreamJoin.mockReturnValue(new Promise(() => {})); // never resolves

      renderHook(() => useChannelStreamSocket('page-a'));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });
      vi.mocked(releaseBootstrapConsumer).mockClear();

      act(() => { mockSocket._trigger('access_revoked', { room: 'page-a', reason: 'permission_revoked' }); });

      expect(releaseBootstrapConsumer).toHaveBeenCalledWith('msg-1');
    });

    it('given the hook unmounts, should remove the access_revoked listener', () => {
      const { unmount } = renderHook(() => useChannelStreamSocket('page-a'));

      unmount();
      mockClearPageStreams.mockClear();

      act(() => { mockSocket._trigger('access_revoked', { room: 'page-a', reason: 'permission_revoked' }); });

      expect(mockClearPageStreams).not.toHaveBeenCalled();
    });
  });

  describe('cleanup on unmount', () => {
    it('should remove socket listeners, abort controllers, and clearPageStreams', () => {
      const { unmount } = renderHook(() => useChannelStreamSocket('page-a'));

      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      let capturedSignal!: AbortSignal;
      const lastCall = mockConsumeStreamJoin.mock.calls.at(-1);
      if (lastCall) capturedSignal = lastCall[1] as AbortSignal;

      unmount();

      if (capturedSignal) expect(capturedSignal.aborted).toBe(true);
      expect(mockClearPageStreams).toHaveBeenCalledWith('page-a');
      expect(mockSocket.off).toHaveBeenCalledWith('chat:stream_start', expect.any(Function));
      expect(mockSocket.off).toHaveBeenCalledWith('chat:stream_complete', expect.any(Function));
    });
  });

  // AC5 — DB bootstrap on mount
  describe('DB bootstrap on mount', () => {
    it('given the hook mounts, should fetch active streams for the channelId', async () => {
      renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); });

      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/chat/active-streams?channelId=page-a',
        expect.objectContaining({ credentials: 'include' }),
      );
    });

    it('given the channelId contains characters needing encoding, should encode it in the URL', async () => {
      renderHook(() => useChannelStreamSocket('user:abc:global'));

      await act(async () => { await Promise.resolve(); });

      expect(mockFetchWithAuth).toHaveBeenCalledWith(
        '/api/ai/chat/active-streams?channelId=user%3Aabc%3Aglobal',
        expect.objectContaining({ credentials: 'include' }),
      );
    });

    it('given a remote-tab stream is active in the DB, should addStream with isOwn=false and start consumeStreamJoin', async () => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-bootstrap',
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });

      renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); });

      expect(mockAddStream).toHaveBeenCalledWith({
        messageId: 'msg-bootstrap',
        pageId: 'page-a',
        conversationId: 'conv-1',
        triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
        isOwn: false,
        parts: [],
      });
      expect(mockConsumeStreamJoin).toHaveBeenCalledWith(
        'msg-bootstrap',
        expect.any(AbortSignal),
        expect.any(Function),
      );
    });

    it('given a bootstrapped stream carries persisted raw text-delta parts, should fold them into addStream initial parts the same way live appendPart would', async () => {
      // The persisted snapshot is the raw registry buffer — one entry per
      // pushed text delta — not a pre-folded array.
      const persistedParts = [{ type: 'text', text: 'partial' }, { type: 'text', text: ' content' }];
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-bootstrap',
            conversationId: 'conv-1',
            parts: persistedParts,
            triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });

      renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); });

      expect(mockAddStream).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'msg-bootstrap',
        // Folded to one merged text part, matching what two live appendPart
        // calls with the same deltas would have produced in the store.
        parts: [{ type: 'text', text: 'partial content' }],
      }));
      // Seeding must NOT go through the store's appendPart action — addStream
      // no-ops when the entry already exists, which is what makes a second
      // co-mounted surface's bootstrap unable to duplicate the snapshot.
      expect(mockAppendPart).not.toHaveBeenCalled();
    });

    it('given a bootstrapped stream carries a completed tool call as two raw frames, should fold to a single converged tool part', async () => {
      const persistedParts = [
        { type: 'tool-search', toolCallId: 'call-1', toolName: 'search', state: 'input-available', input: { q: 'x' } },
        { type: 'tool-search', toolCallId: 'call-1', toolName: 'search', state: 'output-available', input: { q: 'x' }, output: { results: [] } },
      ];
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-tool',
            conversationId: 'conv-1',
            parts: persistedParts,
            triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });

      renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); });

      expect(mockAddStream).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'msg-tool',
        // Without folding, both raw frames would render as separate tool
        // parts sharing one toolCallId — a duplicate "still running" entry
        // beside the completed one instead of a single converged part.
        parts: [persistedParts[1]],
      }));
    });

    it('given a persisted snapshot contains a malformed frame, should drop it before seeding (same wire-trust gate the live SSE path applies)', async () => {
      const persistedParts = [
        { type: 'text', text: 'ok' },
        { toolCallId: 'call-1' }, // missing `type` — not a valid part frame
        { type: 'tool-search', toolName: 'search' }, // tool part missing toolCallId
      ];
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-malformed',
            conversationId: 'conv-1',
            parts: persistedParts,
            triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });

      renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); });

      expect(mockAddStream).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'msg-malformed',
        parts: [{ type: 'text', text: 'ok' }],
      }));
    });

    it('given persisted parts were seeded and the live join then fails (originator process died), should keep the restored snapshot in the store', async () => {
      const persistedParts = [{ type: 'text', text: 'partial' }];
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-dead',
            conversationId: 'conv-1',
            parts: persistedParts,
            triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });
      mockConsumeStreamJoin.mockRejectedValueOnce(new Error('Stream join failed with status 404'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      // The persisted snapshot is the only surviving copy of the partial
      // content — the failed join must not wipe it.
      expect(mockRemoveStream).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('given the snapshot was kept after a failed join, a later chat:stream_complete should still remove it', async () => {
      const persistedParts = [{ type: 'text', text: 'partial' }];
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-1',
            conversationId: 'conv-1',
            parts: persistedParts,
            triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });
      mockConsumeStreamJoin.mockRejectedValueOnce(new Error('Stream join failed with status 404'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      renderHook(() => useChannelStreamSocket('page-a'));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(mockRemoveStream).not.toHaveBeenCalled();

      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(mockRemoveStream).toHaveBeenCalledWith('msg-1');
      errorSpy.mockRestore();
    });

    it('given persisted parts were seeded and the live join replays the same prefix, should skip the duplicate replayed chunks', async () => {
      const persistedParts = [{ type: 'text', text: 'partial' }];
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-bootstrap',
            conversationId: 'conv-1',
            parts: persistedParts,
            triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });
      let capturedOnChunk!: (part: unknown) => void;
      mockConsumeStreamJoin.mockImplementation(
        (_id: string, _signal: AbortSignal, onChunk: (part: unknown) => void) => {
          capturedOnChunk = onChunk;
          return new Promise(() => {});
        },
      );

      renderHook(() => useChannelStreamSocket('page-a'));
      await act(async () => { await Promise.resolve(); });

      mockAppendPart.mockClear();

      // Live join replays its full buffer, starting with the same part we
      // already seeded from the persisted snapshot, followed by genuinely new content.
      const newPart = { type: 'text', text: ' — and more' };
      capturedOnChunk(persistedParts[0]);
      capturedOnChunk(newPart);

      expect(mockAppendPart).toHaveBeenCalledTimes(1);
      expect(mockAppendPart).toHaveBeenCalledWith('msg-bootstrap', newPart);
    });

    it('given no persisted parts, should not skip any live-joined chunks', async () => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-bootstrap',
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });
      let capturedOnChunk!: (part: unknown) => void;
      mockConsumeStreamJoin.mockImplementation(
        (_id: string, _signal: AbortSignal, onChunk: (part: unknown) => void) => {
          capturedOnChunk = onChunk;
          return new Promise(() => {});
        },
      );

      renderHook(() => useChannelStreamSocket('page-a'));
      await act(async () => { await Promise.resolve(); });

      mockAppendPart.mockClear();
      const firstLivePart = { type: 'text', text: 'hello' };
      capturedOnChunk(firstLivePart);

      expect(mockAppendPart).toHaveBeenCalledWith('msg-bootstrap', firstLivePart);
    });

    it('given a stream from the current tab is active in the DB, should addStream with isOwn=true', async () => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-own',
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        }),
      });

      renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); });

      expect(mockAddStream).toHaveBeenCalledWith(expect.objectContaining({
        messageId: 'msg-own',
        isOwn: true,
      }));
    });

    it('given a stream is already in processedRef (completed via socket race), should not re-add', async () => {
      mockFetchWithAuth.mockImplementationOnce(async () => {
        await Promise.resolve();
        return {
          ok: true,
          json: async () => ({
            streams: [{
              messageId: 'msg-1',
              conversationId: 'conv-1',
              triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
            }],
          }),
        };
      });

      const onStreamComplete = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onStreamComplete }));

      // Fire stream_complete BEFORE the bootstrap fetch resolves —
      // this populates processedRef, so the bootstrap should skip msg-1.
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(mockAddStream).not.toHaveBeenCalled();
    });

    it('given the bootstrap fetch fails, should warn and not throw', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockFetchWithAuth.mockRejectedValueOnce(new Error('network down'));

      renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(warn).toHaveBeenCalledWith(
        '[useChannelStreamSocket] bootstrap failed',
        expect.any(Error),
      );
      warn.mockRestore();
    });
  });

  // AC6 — bootstrap unmount safety
  // AC2. socket.io reconnects the SAME instance in place, so the main effect
  // (deps [socket, channelId]) does not re-run — without this, every chat:stream_start
  // emitted during an offline blip is lost and the tab stays blind to a live stream
  // until it is reloaded.
  // The reconciliation snapshot is what releases a consumer's Stop-slot claim when the
  // stream it names has ended. It is authoritative, so it must be RIGHT: it may only speak
  // on a successful, non-superseded response, and access_revoked — which latches
  // `cancelled` and therefore silences every future bootstrap on this channel — must
  // release the claims itself or they strand forever.
  describe('onActiveStreamsSnapshot', () => {
    it('given a successful bootstrap, should report the live messageIds', async () => {
      const onActiveStreamsSnapshot = vi.fn();
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-live',
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-2', displayName: 'A', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });

      renderHook(() => useChannelStreamSocket('page-a', { onActiveStreamsSnapshot }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(onActiveStreamsSnapshot).toHaveBeenCalledWith(new Set(['msg-live']));
    });

    it('given the bootstrap fetch fails, should NOT report a snapshot (never release a claim on no information)', async () => {
      const onActiveStreamsSnapshot = vi.fn();
      mockFetchWithAuth.mockResolvedValueOnce({ ok: false, json: async () => ({}) });

      renderHook(() => useChannelStreamSocket('page-a', { onActiveStreamsSnapshot }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(onActiveStreamsSnapshot).not.toHaveBeenCalled();
    });

    it('given the bootstrap throws, should NOT report a snapshot', async () => {
      const onActiveStreamsSnapshot = vi.fn();
      mockFetchWithAuth.mockRejectedValueOnce(new Error('network down'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      renderHook(() => useChannelStreamSocket('page-a', { onActiveStreamsSnapshot }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(onActiveStreamsSnapshot).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    // access_revoked latches `cancelled` on this effect's closure, so every future
    // runBootstrap — including the reconnect re-bootstrap and rejoinActiveStreams, which
    // both call through bootstrapRef into THIS closure — returns early. The snapshot can
    // never fire again on this channel, so a claim released only by it would strand
    // forever: a Stop button over a stream the user can no longer even reach.
    it('given access is revoked, should finalize every own stream so no claim strands', async () => {
      const onOwnStreamFinalize = vi.fn();
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-own',
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        }),
      });

      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamFinalize }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      act(() => { mockSocket._trigger('access_revoked', { room: 'page-a' }); });

      expect(onOwnStreamFinalize).toHaveBeenCalledWith({ messageId: 'msg-own' });
    });
  });

  describe('re-bootstrap on socket reconnect', () => {
    it('given the socket reconnects after an initial connect, should re-run the DB bootstrap', async () => {
      const { rerender } = renderHook(() => useChannelStreamSocket('page-a'));
      await act(async () => { await Promise.resolve(); });

      const bootstrapCallsAfterMount = mockFetchWithAuth.mock.calls.length;

      // First connect — already covered by the mount bootstrap, must NOT refetch.
      mockConnectionStatus = 'connected';
      await act(async () => { rerender(); await Promise.resolve(); });
      expect(mockFetchWithAuth.mock.calls.length).toBe(bootstrapCallsAfterMount);

      // Drop, then reconnect.
      mockConnectionStatus = 'disconnected';
      await act(async () => { rerender(); await Promise.resolve(); });
      mockConnectionStatus = 'connected';
      await act(async () => { rerender(); await Promise.resolve(); });

      expect(mockFetchWithAuth.mock.calls.length).toBe(bootstrapCallsAfterMount + 1);
      expect(mockFetchWithAuth).toHaveBeenLastCalledWith(
        '/api/ai/chat/active-streams?channelId=page-a',
        expect.anything(),
      );
    });

    it('given the very first connect, should NOT re-bootstrap (the mount already did)', async () => {
      const { rerender } = renderHook(() => useChannelStreamSocket('page-a'));
      await act(async () => { await Promise.resolve(); });

      const callsAfterMount = mockFetchWithAuth.mock.calls.length;

      mockConnectionStatus = 'connecting';
      await act(async () => { rerender(); await Promise.resolve(); });
      mockConnectionStatus = 'connected';
      await act(async () => { rerender(); await Promise.resolve(); });

      expect(mockFetchWithAuth.mock.calls.length).toBe(callsAfterMount);
    });

    it('given no channelId, should never bootstrap on reconnect', async () => {
      const { rerender } = renderHook(() => useChannelStreamSocket(undefined));
      await act(async () => { await Promise.resolve(); });

      mockConnectionStatus = 'connected';
      await act(async () => { rerender(); await Promise.resolve(); });
      mockConnectionStatus = 'disconnected';
      await act(async () => { rerender(); await Promise.resolve(); });
      mockConnectionStatus = 'connected';
      await act(async () => { rerender(); await Promise.resolve(); });

      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });
  });

  describe('bootstrap unmount safety', () => {
    it('given fetch resolves after unmount, should not call addStream', async () => {
      let resolveFetch!: (value: unknown) => void;
      mockFetchWithAuth.mockImplementationOnce(
        () => new Promise((res) => { resolveFetch = res; }),
      );

      const { unmount } = renderHook(() => useChannelStreamSocket('page-a'));
      unmount();

      await act(async () => {
        resolveFetch({
          ok: true,
          json: async () => ({
            streams: [{
              messageId: 'msg-late',
              conversationId: 'conv-1',
              triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
            }],
          }),
        });
        await Promise.resolve();
      });

      expect(mockAddStream).not.toHaveBeenCalled();
      expect(mockConsumeStreamJoin).not.toHaveBeenCalled();
    });

    it('given a bootstrap controller is in flight, should abort it on unmount', async () => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-bootstrap',
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });
      mockConsumeStreamJoin.mockReturnValue(new Promise(() => {})); // never resolves

      const { unmount } = renderHook(() => useChannelStreamSocket('page-a'));

      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      let capturedSignal!: AbortSignal;
      const lastCall = mockConsumeStreamJoin.mock.calls.at(-1);
      if (lastCall) capturedSignal = lastCall[1] as AbortSignal;

      unmount();

      expect(capturedSignal.aborted).toBe(true);
    });
  });

  describe('onOwnStreamBootstrap', () => {
    it('given a bootstrapped stream from the local browser session, should fire onOwnStreamBootstrap exactly once with the messageId', async () => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-own-bootstrap',
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        }),
      });
      const onOwnStreamBootstrap = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamBootstrap }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(onOwnStreamBootstrap).toHaveBeenCalledTimes(1);
      // The STREAM's conversation, asserted exactly — not expect.any(String), which would have
      // accepted the channelId ('page-a'), the messageId, or ''. This value decides which
      // conversation's Stop button lights up; a wrong one lights the wrong surface.
      expect(onOwnStreamBootstrap).toHaveBeenCalledWith({
        messageId: 'msg-own-bootstrap',
        conversationId: 'conv-1',
      });
    });

    it('given a bootstrapped stream from a remote tab, should not fire onOwnStreamBootstrap', async () => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId: 'msg-remote-bootstrap',
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-2', displayName: 'Alice', browserSessionId: SESSION_ID_REMOTE },
          }],
        }),
      });
      const onOwnStreamBootstrap = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamBootstrap }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      expect(onOwnStreamBootstrap).not.toHaveBeenCalled();
    });

    it('given a chat:stream_start fires after mount, should not fire onOwnStreamBootstrap', () => {
      const onOwnStreamBootstrap = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamBootstrap }));
      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });

      expect(onOwnStreamBootstrap).not.toHaveBeenCalled();
    });
  });

  describe('onOwnStreamFinalize', () => {
    const bootstrapOwnStream = (messageId = 'msg-own') => {
      mockFetchWithAuth.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          streams: [{
            messageId,
            conversationId: 'conv-1',
            triggeredBy: { userId: 'user-1', displayName: 'Me', browserSessionId: SESSION_ID_LOCAL },
          }],
        }),
      });
    };

    it('given a bootstrapped own stream completes via SSE resolve, should fire onOwnStreamFinalize exactly once', async () => {
      bootstrapOwnStream();
      let resolveJoin!: () => void;
      mockConsumeStreamJoin.mockReturnValue(
        new Promise<{ aborted: boolean }>((res) => { resolveJoin = () => res({ aborted: false }); }),
      );
      const onOwnStreamFinalize = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamFinalize }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      await act(async () => { resolveJoin(); });

      expect(onOwnStreamFinalize).toHaveBeenCalledTimes(1);
      expect(onOwnStreamFinalize).toHaveBeenCalledWith({ messageId: 'msg-own' });
    });

    it('given a bootstrapped own stream is finalized via chat:stream_complete socket, should fire onOwnStreamFinalize exactly once', async () => {
      bootstrapOwnStream();
      mockConsumeStreamJoin.mockReturnValue(new Promise(() => {})); // never resolves
      const onOwnStreamFinalize = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamFinalize }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      act(() => {
        mockSocket._trigger('chat:stream_complete', { messageId: 'msg-own', pageId: 'page-a' });
      });
      await act(async () => { await Promise.resolve(); });

      expect(onOwnStreamFinalize).toHaveBeenCalledTimes(1);
      expect(onOwnStreamFinalize).toHaveBeenCalledWith({ messageId: 'msg-own' });
    });

    it('given both SSE resolve and chat:stream_complete fire for the same own stream, should fire onOwnStreamFinalize exactly once', async () => {
      bootstrapOwnStream();
      let resolveJoin!: () => void;
      mockConsumeStreamJoin.mockReturnValue(
        new Promise<{ aborted: boolean }>((res) => { resolveJoin = () => res({ aborted: false }); }),
      );
      const onOwnStreamFinalize = vi.fn();

      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamFinalize }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      await act(async () => { resolveJoin(); });
      act(() => {
        mockSocket._trigger('chat:stream_complete', { messageId: 'msg-own', pageId: 'page-a' });
      });

      expect(onOwnStreamFinalize).toHaveBeenCalledTimes(1);
    });

    it('given a remote stream completes, should not fire onOwnStreamFinalize', async () => {
      const onOwnStreamFinalize = vi.fn();
      renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamFinalize }));

      act(() => { mockSocket._trigger('chat:stream_start', START_PAYLOAD); });
      act(() => { mockSocket._trigger('chat:stream_complete', COMPLETE_PAYLOAD); });

      expect(onOwnStreamFinalize).not.toHaveBeenCalled();
    });

    it('given the hook unmounts while an own stream is in flight, should not fire onOwnStreamFinalize', async () => {
      bootstrapOwnStream();
      mockConsumeStreamJoin.mockReturnValue(new Promise(() => {}));
      const onOwnStreamFinalize = vi.fn();

      const { unmount } = renderHook(() => useChannelStreamSocket('page-a', { onOwnStreamFinalize }));
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });

      unmount();
      await act(async () => { await Promise.resolve(); });

      expect(onOwnStreamFinalize).not.toHaveBeenCalled();
    });
  });
});

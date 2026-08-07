import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UIMessage } from 'ai';

/**
 * `useConversationSubscription` — the four things it owns, one describe each:
 * ensure-an-entry (which is what lets the `hasEntry` gates be deleted), join the
 * conversation room, apply events through the rev rule, and prove currency on
 * reconnect with ONE batched request.
 *
 * The pure decision table itself lives in
 * `src/lib/realtime/__tests__/conversation-apply.test.ts` and is not re-tested
 * here; this suite pins that the hook actually consults it and does the right IO
 * with each answer.
 */

const {
  mockSocket,
  socketHandlers,
  emitted,
  mockSocketStatus,
  mockLoadAgent,
  mockLoadGlobal,
  mockRefreshSnapshot,
  mockHealConversationToRev,
  mockRegisterWatch,
  mockUnregisterWatch,
  mockSyncRevs,
  capturedStreamSocket,
} = vi.hoisted(() => {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const emittedEvents: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    on: (event: string, handler: (payload: unknown) => void) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    off: (event: string, handler: (payload: unknown) => void) => {
      const list = (handlers.get(event) ?? []).filter((h) => h !== handler);
      handlers.set(event, list);
    },
    emit: (event: string, payload?: unknown) => {
      emittedEvents.push({ event, payload });
    },
  };
  return {
    mockSocket: { current: socket as typeof socket | null },
    socketHandlers: handlers,
    emitted: emittedEvents,
    mockSocketStatus: { current: 'disconnected' as 'disconnected' | 'connecting' | 'connected' | 'error' },
    mockLoadAgent: vi.fn().mockResolvedValue(undefined),
    mockLoadGlobal: vi.fn().mockResolvedValue(undefined),
    mockRefreshSnapshot: vi.fn().mockResolvedValue(undefined),
    mockHealConversationToRev: vi.fn().mockResolvedValue(undefined),
    mockRegisterWatch: vi.fn(),
    mockUnregisterWatch: vi.fn(),
    mockSyncRevs: vi.fn().mockResolvedValue(undefined),
    capturedStreamSocket: {
      channelId: undefined as string | undefined,
      bootstrapConversationId: undefined as string | null | undefined,
    },
  };
});

vi.mock('@/hooks/useSocket', () => ({ useSocket: () => mockSocket.current }));

vi.mock('@/stores/useSocketStore', () => ({
  useSocketStore: vi.fn((selector: (s: { connectionStatus: string }) => unknown) =>
    selector({ connectionStatus: mockSocketStatus.current }),
  ),
}));

vi.mock('@/hooks/useChannelStreamSocket', () => ({
  useChannelStreamSocket: (
    channelId: string | undefined,
    _options: unknown,
    bootstrapConversationId?: string | null,
  ) => {
    capturedStreamSocket.channelId = channelId;
    capturedStreamSocket.bootstrapConversationId = bootstrapConversationId;
    return { rejoinActiveStreams: vi.fn() };
  },
}));

vi.mock('@/hooks/conversationMessagesLoaders', () => ({
  loadAgentConversationMessages: mockLoadAgent,
  loadGlobalConversationMessages: mockLoadGlobal,
  refreshConversationSnapshot: mockRefreshSnapshot,
}));

vi.mock('@/lib/realtime/conversation-rev-sync', () => ({
  healConversationToRev: mockHealConversationToRev,
  registerConversationWatch: mockRegisterWatch,
  unregisterConversationWatch: mockUnregisterWatch,
  syncWatchedConversationRevs: mockSyncRevs,
}));

// Real store: what lands in the cache IS the behavior under test.
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import { useConversationSubscription } from '../useConversationSubscription';

const CONV = 'conv-1';
const AGENT_PAGE = 'agent-page-1';

const assistant = (id: string, text: string): UIMessage =>
  ({ id, role: 'assistant', parts: [{ type: 'text', text }] }) as UIMessage;

const fire = (event: string, payload: unknown) => {
  act(() => {
    for (const handler of socketHandlers.get(event) ?? []) handler(payload);
  });
};

const entry = (conversationId: string) =>
  useConversationMessagesStore.getState().getEntry(conversationId);

/** Seed a conversation as loaded at a known watermark, the way a message-list GET does. */
const seedAt = (conversationId: string, rev: number | null, messages: UIMessage[] = []) => {
  const store = useConversationMessagesStore.getState();
  const generation = store.startLoad(conversationId);
  store.applyLoad(conversationId, generation, messages, undefined, rev);
};

const render = (conversationId: string | null, agentPageId: string | null = AGENT_PAGE, channelId?: string | null) =>
  renderHook(() => useConversationSubscription(conversationId, { channelId, agentPageId }));

describe('useConversationSubscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketHandlers.clear();
    emitted.length = 0;
    mockSocketStatus.current = 'disconnected';
    capturedStreamSocket.channelId = undefined;
    capturedStreamSocket.bootstrapConversationId = undefined;
    useConversationMessagesStore.setState({ byConversationId: {} });
  });

  describe('subscribe-on-open (what replaces the hasEntry gate)', () => {
    it('given a conversation with no cache entry, should kick the loader so an entry exists before any event can arrive', () => {
      render(CONV);

      expect(mockLoadAgent).toHaveBeenCalledWith(AGENT_PAGE, CONV);
    });

    it('given no agent page (a global-assistant conversation), should kick the GLOBAL loader', () => {
      render(CONV, null);

      expect(mockLoadGlobal).toHaveBeenCalledWith(CONV);
      expect(mockLoadAgent).not.toHaveBeenCalled();
    });

    it('given the conversation is already cached, should not re-fetch it', () => {
      seedAt(CONV, 3);

      render(CONV);

      expect(mockLoadAgent).not.toHaveBeenCalled();
    });

    it('given no conversation id, should do nothing at all', () => {
      render(null);

      expect(mockLoadAgent).not.toHaveBeenCalled();
      expect(emitted).toEqual([]);
    });
  });

  describe('conversation room membership', () => {
    it('should join `conv:<id>` on mount', () => {
      render(CONV);

      expect(emitted).toContainEqual({ event: 'join_conversation', payload: CONV });
    });

    it('should re-join on every reconnect — socket.io restores no rooms', () => {
      render(CONV);
      emitted.length = 0;

      act(() => {
        for (const handler of socketHandlers.get('connect') ?? []) handler(undefined);
      });

      expect(emitted).toEqual([{ event: 'join_conversation', payload: CONV }]);
    });

    it('should leave the room on unmount', () => {
      const { unmount } = render(CONV);
      emitted.length = 0;

      unmount();

      expect(emitted).toContainEqual({ event: 'leave_conversation', payload: CONV });
    });

    it('given the conversation id changes, should leave the old room and join the new one', () => {
      const { rerender } = renderHook(
        ({ id }: { id: string }) => useConversationSubscription(id, { agentPageId: AGENT_PAGE }),
        { initialProps: { id: CONV } },
      );
      emitted.length = 0;

      rerender({ id: 'conv-2' });

      expect(emitted).toEqual([
        { event: 'leave_conversation', payload: CONV },
        { event: 'join_conversation', payload: 'conv-2' },
      ]);
    });
  });

  describe('conversation:message_created / _updated — the rev rule in action', () => {
    it('given the contiguous next rev, should upsert the message and advance the watermark', () => {
      seedAt(CONV, 4);
      render(CONV);

      fire('conversation:message_created', {
        conversationId: CONV,
        rev: 5,
        message: assistant('m-1', 'pong'),
      });

      expect(entry(CONV).messages).toEqual([assistant('m-1', 'pong')]);
      expect(entry(CONV).rev).toBe(5);
    });

    it('given a rev at or below the watermark, should drop it — no write, no fetch', () => {
      seedAt(CONV, 5);
      render(CONV);

      fire('conversation:message_created', {
        conversationId: CONV,
        rev: 5,
        message: assistant('m-1', 'already have this'),
      });

      expect(entry(CONV).messages).toEqual([]);
      expect(mockHealConversationToRev).not.toHaveBeenCalled();
    });

    it('given a GAP, should refetch rather than patch a cache it cannot prove current', () => {
      seedAt(CONV, 4);
      render(CONV);

      fire('conversation:message_created', {
        conversationId: CONV,
        rev: 9,
        message: assistant('m-1', 'from the future'),
      });

      expect(entry(CONV).messages).toEqual([]);
      expect(mockHealConversationToRev).toHaveBeenCalledWith(CONV, AGENT_PAGE, 9);
    });

    it('given a TRUNCATED payload (the message was too large to inline), should refetch', () => {
      seedAt(CONV, 4);
      render(CONV);

      fire('conversation:message_created', {
        conversationId: CONV,
        rev: 5,
        truncated: true,
        messageRef: { id: 'm-huge', role: 'assistant', status: 'complete', createdAt: '2024-01-01T00:00:00.000Z' },
      });

      expect(entry(CONV).messages).toEqual([]);
      expect(mockHealConversationToRev).toHaveBeenCalledWith(CONV, AGENT_PAGE, 5);
    });

    it('given an event for a DIFFERENT conversation, should ignore it entirely', () => {
      seedAt(CONV, 4);
      render(CONV);

      fire('conversation:message_created', {
        conversationId: 'conv-other',
        rev: 5,
        message: assistant('m-1', 'not mine'),
      });

      expect(entry(CONV).messages).toEqual([]);
      expect(entry('conv-other').messages).toEqual([]);
      expect(mockHealConversationToRev).not.toHaveBeenCalled();
    });

    // The dispatch case: the pane's own optimistic send, then the server's echo of
    // the very same id. Upsert-by-id means the echo reconciles rather than duplicates.
    it('given the echo of this pane\'s own optimistic send, should reconcile it instead of duplicating', () => {
      seedAt(CONV, 4);
      const own = { id: 'u-1', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as UIMessage;
      useConversationMessagesStore.getState().addOptimisticSend(CONV, own);
      render(CONV);

      fire('conversation:message_created', { conversationId: CONV, rev: 5, message: own });

      expect(entry(CONV).messages).toEqual([own]);
      expect(entry(CONV).optimisticSends).toEqual([]);
    });

    it('given `_updated` for a row already in the cache, should REPLACE it (a streaming placeholder becoming the final reply)', () => {
      seedAt(CONV, 4, [assistant('m-1', 'half-writ')]);
      render(CONV);

      fire('conversation:message_updated', {
        conversationId: CONV,
        rev: 5,
        message: assistant('m-1', 'the whole reply'),
      });

      expect(entry(CONV).messages).toEqual([assistant('m-1', 'the whole reply')]);
    });

    it('given no watermark yet (the load has not committed one), should refetch rather than guess', () => {
      seedAt(CONV, null);
      render(CONV);

      fire('conversation:message_created', {
        conversationId: CONV,
        rev: 1,
        message: assistant('m-1', 'first'),
      });

      expect(mockHealConversationToRev).toHaveBeenCalledWith(CONV, AGENT_PAGE, 1);
    });

    it('given an UNVERSIONED event (rev 0 — a conversation with no row), should apply it and leave the watermark alone', () => {
      seedAt(CONV, 7);
      render(CONV);

      fire('conversation:message_created', {
        conversationId: CONV,
        rev: 0,
        message: assistant('m-1', 'legacy page conversation'),
      });

      expect(entry(CONV).messages).toEqual([assistant('m-1', 'legacy page conversation')]);
      expect(entry(CONV).rev).toBe(7);
    });

    it('given an apply-decision payload carrying no message at all (an emitter we do not know), should refetch instead of writing junk', () => {
      seedAt(CONV, 4);
      render(CONV);

      fire('conversation:message_created', { conversationId: CONV, rev: 5 });

      expect(entry(CONV).messages).toEqual([]);
      expect(mockHealConversationToRev).toHaveBeenCalledWith(CONV, AGENT_PAGE, 5);
    });
  });

  describe('conversation:message_deleted', () => {
    it('given the contiguous next rev, should delete the row and advance the watermark', () => {
      seedAt(CONV, 4, [assistant('m-1', 'doomed'), assistant('m-2', 'survivor')]);
      render(CONV);

      fire('conversation:message_deleted', { conversationId: CONV, rev: 5, messageId: 'm-1' });

      expect(entry(CONV).messages.map((m) => m.id)).toEqual(['m-2']);
      expect(entry(CONV).rev).toBe(5);
    });

    it('given a stale rev, should drop it', () => {
      seedAt(CONV, 5, [assistant('m-1', 'still here')]);
      render(CONV);

      fire('conversation:message_deleted', { conversationId: CONV, rev: 3, messageId: 'm-1' });

      expect(entry(CONV).messages.map((m) => m.id)).toEqual(['m-1']);
    });

    it('given a gap, should refetch rather than delete blind', () => {
      seedAt(CONV, 4, [assistant('m-1', 'still here')]);
      render(CONV);

      fire('conversation:message_deleted', { conversationId: CONV, rev: 12, messageId: 'm-1' });

      expect(entry(CONV).messages.map((m) => m.id)).toEqual(['m-1']);
      expect(mockHealConversationToRev).toHaveBeenCalledWith(CONV, AGENT_PAGE, 12);
    });
  });

  describe('conversation:undo_applied', () => {
    it('should refetch — an undo restructures the conversation, there is no patch to apply', () => {
      seedAt(CONV, 4);
      render(CONV);

      fire('conversation:undo_applied', {
        conversationId: CONV,
        rev: 5,
        mode: 'messages_only',
        affectedMessageIds: ['m-1'],
      });

      expect(mockHealConversationToRev).toHaveBeenCalledWith(CONV, AGENT_PAGE, 5);
    });

    it('given a redelivered undo below the watermark, should not pay for a fetch', () => {
      seedAt(CONV, 9);
      render(CONV);

      fire('conversation:undo_applied', {
        conversationId: CONV,
        rev: 5,
        mode: 'messages_only',
        affectedMessageIds: ['m-1'],
      });

      expect(mockHealConversationToRev).not.toHaveBeenCalled();
    });
  });

  describe('reconnect: one batched rev check for every subscription', () => {
    it('should register the conversation in the shared watch registry on mount and unregister on unmount', () => {
      const { unmount } = render(CONV);
      expect(mockRegisterWatch).toHaveBeenCalledWith(CONV, AGENT_PAGE);

      unmount();
      expect(mockUnregisterWatch).toHaveBeenCalledWith(CONV);
    });

    it('given the socket goes connected → disconnected → connected, should run the batched rev sync exactly once', () => {
      const { rerender } = renderHook(() => useConversationSubscription(CONV, { agentPageId: AGENT_PAGE }));

      mockSocketStatus.current = 'connected';
      rerender();
      expect(mockSyncRevs).not.toHaveBeenCalled(); // the FIRST connect is covered by the mount load

      mockSocketStatus.current = 'disconnected';
      rerender();
      mockSocketStatus.current = 'connected';
      rerender();

      expect(mockSyncRevs).toHaveBeenCalledTimes(1);
    });
  });

  describe('stream plane hand-off', () => {
    it('given a channel id, should bootstrap the channel socket SCOPED to this conversation', () => {
      render(CONV, AGENT_PAGE, AGENT_PAGE);

      expect(capturedStreamSocket.channelId).toBe(AGENT_PAGE);
      expect(capturedStreamSocket.bootstrapConversationId).toBe(CONV);
    });

    it('given NO channel id (a global pane riding the app-wide provider subscription), should mount no channel socket', () => {
      render(CONV, null, null);

      expect(capturedStreamSocket.channelId).toBeUndefined();
    });
  });
});

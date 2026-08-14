/**
 * `onStreamComplete` is now the SOLE owner of two behaviours that used to have a second
 * owner, and these cases MOVED here rather than being deleted with it.
 *
 * They lived in `useAgentSessionChat.test.ts` and `useAssistantSessionChat.test.ts`, asserting
 * them through each surface's `chatConfig.onFinish` (`buildOwnStreamCommitOnFinish`). That
 * callback existed because the sender's own tab never joined its own SSE multicast: at
 * `chat:stream_complete` its store entry was already gone, so the socket handler could only
 * fall back to a full reload — a visible flash, and a vanished reply if the reload failed.
 *
 * Neither premise holds now. This tab DOES subscribe to its own stream (one registry, one
 * subscription, whoever announces it), and the registry fires its end notification on every
 * terminal path — including the purely local one, the SSE join resolving — WHILE THE STORE
 * ENTRY IS STILL PRESENT. So there is one commit path instead of two, and it is this one.
 *
 * The behaviours themselves are unchanged and still matter to a user:
 *   - a finished reply must land in the cache without a reload flash;
 *   - a STOPPED stream must badge 'interrupted' the moment this tab hears about it, rather
 *     than looking complete until the next reload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UIMessage } from 'ai';

const activeStreams = new Map<string, unknown>();

vi.mock('@/hooks/useActiveStream', () => ({
  getActiveStreamById: (messageId: string) => activeStreams.get(messageId),
}));

import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import { buildConversationCacheHandlers } from '../conversationCacheSocketHandlers';

const CONV = 'conv-1';

const stream = (overrides: Record<string, unknown> = {}) => ({
  messageId: 'msg-1',
  pageId: 'page-1',
  conversationId: CONV,
  triggeredBy: { userId: 'u1', displayName: 'Me' },
  parts: [{ type: 'text', text: 'the full reply' }],
  isOwn: true,
  startedAt: '2026-08-14T10:00:00.000Z',
  ...overrides,
});

const entry = () => conversationMessagesActions.getEntry(CONV);

let reloadConversation: ReturnType<typeof vi.fn>;
let refreshSnapshot: ReturnType<typeof vi.fn>;

const handlers = () =>
  buildConversationCacheHandlers({ reloadConversation, refreshSnapshot });

beforeEach(() => {
  vi.clearAllMocks();
  activeStreams.clear();
  useConversationMessagesStore.setState({ byConversationId: {} });
  reloadConversation = vi.fn();
  refreshSnapshot = vi.fn();
});

describe('onStreamComplete — committing the finished reply', () => {
  it('given a live store entry with parts, commits it into the cache without a reload', async () => {
    // The no-flash path. The entry is still present because the registry drops it only AFTER
    // its listeners have run — that ordering is what makes this branch reachable at all.
    conversationMessagesActions.addOptimisticSend(CONV, {
      id: 'm-user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'the question' }],
    } as UIMessage);
    activeStreams.set('msg-1', stream());

    handlers().onStreamComplete('msg-1', CONV, { joinFailed: false }, false);

    const ids = entry().messages.map((m) => m.id);
    expect(ids).toEqual(['m-user-1', 'msg-1']);
    expect(reloadConversation, 'a commit must not also reload — that is the flash').not.toHaveBeenCalled();
    // The background heal still runs: the broadcast can outrace the channel's final frames, so
    // committed parts may be truncated.
    expect(refreshSnapshot).toHaveBeenCalledWith(CONV);
  });

  it('given the user Stopped mid-stream, commits the partial reply badged interrupted', async () => {
    // Moved verbatim in intent from `useAssistantSessionChat.test.ts`. Without this the
    // conversation looks finished until the next reload, so a user who pressed Stop is shown
    // a reply that reads as complete.
    conversationMessagesActions.seedConversation(CONV);
    activeStreams.set('msg-1', stream({ parts: [{ type: 'text', text: 'partial…' }] }));

    handlers().onStreamComplete('msg-1', CONV, { joinFailed: false }, true);

    const committed = entry().messages.find((m) => m.id === 'msg-1') as
      | (UIMessage & { status?: string })
      | undefined;
    expect(committed).toBeDefined();
    expect(committed!.status).toBe('interrupted');
  });

  it('given a NON-aborted completion, badges it complete', () => {
    conversationMessagesActions.seedConversation(CONV);
    activeStreams.set('msg-1', stream());

    handlers().onStreamComplete('msg-1', CONV, { joinFailed: false }, false);

    const committed = entry().messages.find((m) => m.id === 'msg-1') as
      | (UIMessage & { status?: string })
      | undefined;
    expect(committed!.status).toBe('complete');
  });

  it('promotes optimistic sends only for the user\'s OWN reply', () => {
    // An own reply proves the user rows that triggered it are persisted (the route persists the
    // user message before generating), so the question can never render below the answer. A
    // REMOTE reply proves nothing about this tab's sends.
    conversationMessagesActions.addOptimisticSend(CONV, {
      id: 'm-user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'q' }],
    } as UIMessage);
    activeStreams.set('msg-1', stream({ isOwn: false }));

    handlers().onStreamComplete('msg-1', CONV, { joinFailed: false }, false);

    expect(entry().optimisticSends.map((m) => m.id)).toEqual(['m-user-1']);
  });
});

describe('onStreamComplete — falling back to the DB', () => {
  it('given NO usable store entry, reloads rather than losing the reply', () => {
    // The join failed (commonly: the stream lives on another web instance), so whatever we held
    // was a stale snapshot at best — but the message IS durably persisted.
    handlers().onStreamComplete('msg-1', CONV, { joinFailed: true }, false);

    expect(reloadConversation).toHaveBeenCalledWith(CONV);
  });

  it('given an entry with ZERO parts, still reloads — an empty entry is not a reply', () => {
    activeStreams.set('msg-1', stream({ parts: [] }));

    handlers().onStreamComplete('msg-1', CONV, { joinFailed: true }, false);

    expect(reloadConversation).toHaveBeenCalledWith(CONV);
  });

  it('given no conversation to name, does nothing rather than reloading blindly', () => {
    handlers().onStreamComplete('msg-1', undefined, { joinFailed: true }, false);

    expect(reloadConversation).not.toHaveBeenCalled();
  });

  it('given the cache already holds a consistent final row, does not reload for a loading flip', () => {
    conversationMessagesActions.seedConversation(CONV);
    conversationMessagesActions.applyConfirmedMessage(CONV, {
      id: 'msg-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'already here' }],
      status: 'complete',
    } as UIMessage & { status: string });

    handlers().onStreamComplete('msg-1', CONV, { joinFailed: true }, false);

    expect(reloadConversation).not.toHaveBeenCalled();
  });

  it('given a locally-interrupted row and a NON-aborted completion, still reloads', () => {
    // The server may have outrun the abort and persisted the full reply, so a locally-badged
    // 'interrupted' row must not suppress a completion that says otherwise.
    conversationMessagesActions.seedConversation(CONV);
    conversationMessagesActions.applyConfirmedMessage(CONV, {
      id: 'msg-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'partial…' }],
      status: 'interrupted',
    } as UIMessage & { status: string });

    handlers().onStreamComplete('msg-1', CONV, { joinFailed: true }, false);

    expect(reloadConversation).toHaveBeenCalledWith(CONV);
  });
});

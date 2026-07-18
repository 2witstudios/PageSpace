import { describe, it, expect } from 'vitest';
import { applyConversationDelete } from '../applyConversationDelete';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

describe('applyConversationDelete', () => {
  it('given a matching id in confirmed messages, should remove it', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1'), msg('m2')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'm1' });
    expect(result.c1.messages).toEqual([msg('m2')]);
  });

  it('given a matching id in optimisticSends, should remove it from there too', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1')], loadGeneration: 0, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'opt1' });
    expect(result.c1.optimisticSends).toEqual([]);
  });

  it('given an id present in neither array, should leave messages and optimisticSends unchanged (applyMessageDelete no-ops)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'missing' });
    expect(result.c1.messages).toBe(initial.c1.messages);
    expect(result.c1.optimisticSends).toBe(initial.c1.optimisticSends);
  });

  it('given a conversation not tracked at all, should no-op', () => {
    const result = applyConversationDelete({}, { conversationId: 'c1', messageId: 'm1' });
    expect(result).toEqual({});
  });

  it('given an actual delete of a confirmed message, should record it in pendingMutationsSinceLoad so an in-flight load can replay it', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'm1' });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([{ type: 'delete', messageId: 'm1' }]);
  });

  it('given a delete that only removed an optimistic (unconfirmed) send, should STILL record the pending mutation (Codex finding: the send may already be persisted server-side despite not yet being reconciled into messages locally, so a stale load could resurrect it)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1')], loadGeneration: 0, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'opt1' });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([{ type: 'delete', messageId: 'opt1' }]);
  });

  it('given a delete for an id not locally known at all (neither array), should STILL record the pending mutation (a fully unknown message can still exist in a stale in-flight load snapshot)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'never-seen' });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([{ type: 'delete', messageId: 'never-seen' }]);
  });

  it('given an actual delete, should NOT bump loadGeneration (a fresh load already reflecting this delete must not be invalidated)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'm1' });
    expect(result.c1.loadGeneration).toBe(1);
  });
});

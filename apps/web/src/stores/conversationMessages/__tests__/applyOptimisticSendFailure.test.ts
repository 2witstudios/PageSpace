import { describe, it, expect } from 'vitest';
import { applyOptimisticSendFailure } from '../applyOptimisticSendFailure';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

describe('applyOptimisticSendFailure', () => {
  it('given a matching id in optimisticSends, should remove it (send rejected before persisting — M9)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1')], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyOptimisticSendFailure(initial, { conversationId: 'c1', messageId: 'opt1' });
    expect(result.c1.optimisticSends).toEqual([]);
  });

  it('given an id NOT in optimisticSends, should no-op (already promoted/reconciled — a late rejection must not remove a real message)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('opt1')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyOptimisticSendFailure(initial, { conversationId: 'c1', messageId: 'opt1' });
    expect(result.c1.messages).toEqual([msg('opt1')]);
    expect(result).toBe(initial);
  });

  it('given a conversation not tracked at all, should no-op', () => {
    const result = applyOptimisticSendFailure({}, { conversationId: 'c1', messageId: 'opt1' });
    expect(result).toEqual({});
  });

  it('given other conversations tracked, should not touch them', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1')], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
      other: { messages: [], optimisticSends: [msg('x')], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyOptimisticSendFailure(initial, { conversationId: 'c1', messageId: 'opt1' });
    expect(result.other).toBe(initial.other);
  });

  it('given other optimistic sends in the same conversation, should leave them untouched', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1'), msg('opt2')], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyOptimisticSendFailure(initial, { conversationId: 'c1', messageId: 'opt1' });
    expect(result.c1.optimisticSends).toEqual([msg('opt2')]);
  });
});

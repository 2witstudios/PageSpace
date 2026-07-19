import { describe, it, expect } from 'vitest';
import { applyOptimisticSend } from '../applyOptimisticSend';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

describe('applyOptimisticSend', () => {
  it('given a conversation never seen before, should seed it and append the message', () => {
    const result = applyOptimisticSend({}, { conversationId: 'c1', message: msg('opt1') });
    expect(result.c1.optimisticSends).toEqual([msg('opt1')]);
    expect(result.c1.messages).toEqual([]);
  });

  it('given existing optimistic sends, should append after them (send order)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1')], loadGeneration: 0, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyOptimisticSend(initial, { conversationId: 'c1', message: msg('opt2') });
    expect(result.c1.optimisticSends).toEqual([msg('opt1'), msg('opt2')]);
  });

  it('given a message id already present in optimisticSends, should no-op (idempotent)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1')], loadGeneration: 0, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyOptimisticSend(initial, { conversationId: 'c1', message: msg('opt1') });
    expect(result).toBe(initial);
  });

  it('given a message id already present in confirmed messages, should no-op', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyOptimisticSend(initial, { conversationId: 'c1', message: msg('m1') });
    expect(result).toBe(initial);
  });

  it('given other conversations tracked, should not touch them', () => {
    const initial: ConversationMessagesById = {
      other: { messages: [], optimisticSends: [], loadGeneration: 0, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyOptimisticSend(initial, { conversationId: 'c1', message: msg('opt1') });
    expect(result.other).toBe(initial.other);
  });
});

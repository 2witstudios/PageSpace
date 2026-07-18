import { describe, it, expect } from 'vitest';
import { applyConfirmedMessage } from '../applyConfirmedMessage';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string, text = ''): UIMessage => ({
  id,
  role: 'assistant',
  parts: [{ type: 'text', text }],
});

describe('applyConfirmedMessage', () => {
  it('given a conversation never seen before, should seed it and append the message', () => {
    const result = applyConfirmedMessage({}, { conversationId: 'c1', message: msg('m1', 'hi') });
    expect(result.c1.messages).toEqual([msg('m1', 'hi')]);
  });

  it('given the id already confirmed with STALER content, should REPLACE it in place — not no-op', () => {
    const initial: ConversationMessagesById = {
      c1: {
        messages: [msg('m1', 'partial')],
        optimisticSends: [],
        loadGeneration: 1,
        pendingMutationsSinceLoad: [],
        loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false,
      },
    };
    const result = applyConfirmedMessage(initial, { conversationId: 'c1', message: msg('m1', 'full reply') });
    expect(result.c1.messages).toEqual([msg('m1', 'full reply')]);
  });

  it('given the id already confirmed, replaces it AT THE SAME array position (does not reorder or duplicate)', () => {
    const initial: ConversationMessagesById = {
      c1: {
        messages: [msg('before'), msg('m1', 'partial'), msg('after')],
        optimisticSends: [],
        loadGeneration: 1,
        pendingMutationsSinceLoad: [],
        loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false,
      },
    };
    const result = applyConfirmedMessage(initial, { conversationId: 'c1', message: msg('m1', 'full reply') });
    expect(result.c1.messages).toEqual([msg('before'), msg('m1', 'full reply'), msg('after')]);
  });

  it('given the id matches an optimistic send, should append to messages and reconcile it out of optimisticSends', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1')], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConfirmedMessage(initial, { conversationId: 'c1', message: msg('opt1') });
    expect(result.c1.messages).toEqual([msg('opt1')]);
    expect(result.c1.optimisticSends).toEqual([]);
  });

  it('given other optimistic sends unrelated to the confirmed id, should leave them untouched', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1'), msg('opt2')], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConfirmedMessage(initial, { conversationId: 'c1', message: msg('opt1') });
    expect(result.c1.optimisticSends).toEqual([msg('opt2')]);
  });

  it('given an append, should record it in pendingMutationsSinceLoad so an in-flight load can replay it', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConfirmedMessage(initial, { conversationId: 'c1', message: msg('m1') });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([{ type: 'confirmedMessage', message: msg('m1') }]);
  });

  it('given a replace, should also record a pending mutation (unlike applyRemoteUserMessage, which skips no-ops)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1', 'partial')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConfirmedMessage(initial, { conversationId: 'c1', message: msg('m1', 'full') });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([{ type: 'confirmedMessage', message: msg('m1', 'full') }]);
  });

  it('given an append or replace, should NOT bump loadGeneration', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConfirmedMessage(initial, { conversationId: 'c1', message: msg('m1') });
    expect(result.c1.loadGeneration).toBe(1);
  });
});

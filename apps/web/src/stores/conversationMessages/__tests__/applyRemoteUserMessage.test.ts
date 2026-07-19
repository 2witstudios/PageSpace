import { describe, it, expect } from 'vitest';
import { applyRemoteUserMessage } from '../applyRemoteUserMessage';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

describe('applyRemoteUserMessage', () => {
  it('given a conversation never seen before, should seed it and append the message', () => {
    const result = applyRemoteUserMessage({}, { conversationId: 'c1', message: msg('m1') });
    expect(result.c1.messages).toEqual([msg('m1')]);
  });

  it('given the id already confirmed, should no-op (duplicate broadcast)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyRemoteUserMessage(initial, { conversationId: 'c1', message: msg('m1') });
    expect(result).toBe(initial);
  });

  it('given the id matches an optimistic send (own echo), should append to messages and reconcile it out of optimisticSends', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1')], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyRemoteUserMessage(initial, { conversationId: 'c1', message: msg('opt1') });
    expect(result.c1.messages).toEqual([msg('opt1')]);
    expect(result.c1.optimisticSends).toEqual([]);
  });

  it('given other optimistic sends unrelated to the broadcast id, should leave them untouched', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1'), msg('opt2')], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyRemoteUserMessage(initial, { conversationId: 'c1', message: msg('opt1') });
    expect(result.c1.optimisticSends).toEqual([msg('opt2')]);
  });

  it('given an actual append, should record it in pendingMutationsSinceLoad so an in-flight load can replay it', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyRemoteUserMessage(initial, { conversationId: 'c1', message: msg('m1') });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([{ type: 'remoteMessage', message: msg('m1') }]);
  });

  it('given a duplicate broadcast (no-op), should not record a pending mutation', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyRemoteUserMessage(initial, { conversationId: 'c1', message: msg('m1') });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([]);
  });

  it('given an actual append, should NOT bump loadGeneration (a fresh load already covering this message must not be invalidated)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyRemoteUserMessage(initial, { conversationId: 'c1', message: msg('m1') });
    expect(result.c1.loadGeneration).toBe(1);
  });
});

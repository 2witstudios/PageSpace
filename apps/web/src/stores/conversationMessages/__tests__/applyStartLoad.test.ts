import { describe, it, expect } from 'vitest';
import { applyStartLoad } from '../applyStartLoad';
import type { ConversationMessagesById } from '../seedEmpty';

describe('applyStartLoad', () => {
  it('given a conversation never seen before, should seed it and return generation 1', () => {
    const { byConversationId, generation } = applyStartLoad({}, 'c1');
    expect(generation).toBe(1);
    expect(byConversationId.c1).toEqual({
      messages: [],
      optimisticSends: [],
      loadGeneration: 1,
      pendingMutationsSinceLoad: [],
      loadStatus: 'loading', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false,
    });
  });

  it('given a conversation already at generation 1, should bump to generation 2', () => {
    const initial: ConversationMessagesById = {
      c1: {
        messages: [{ id: 'm1', role: 'user', parts: [] }],
        optimisticSends: [],
        loadGeneration: 1,
        pendingMutationsSinceLoad: [],
        loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false,
      },
    };
    const { byConversationId, generation } = applyStartLoad(initial, 'c1');
    expect(generation).toBe(2);
    expect(byConversationId.c1.loadGeneration).toBe(2);
  });

  it('given a bump, should preserve existing messages and optimisticSends untouched', () => {
    const initial: ConversationMessagesById = {
      c1: {
        messages: [{ id: 'm1', role: 'user', parts: [] }],
        optimisticSends: [{ id: 'opt1', role: 'user', parts: [] }],
        loadGeneration: 1,
        pendingMutationsSinceLoad: [],
        loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false,
      },
    };
    const { byConversationId } = applyStartLoad(initial, 'c1');
    expect(byConversationId.c1.messages).toBe(initial.c1.messages);
    expect(byConversationId.c1.optimisticSends).toBe(initial.c1.optimisticSends);
  });

  it('given other conversations tracked, should not touch them', () => {
    const initial: ConversationMessagesById = {
      other: { messages: [], optimisticSends: [], loadGeneration: 3, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const { byConversationId } = applyStartLoad(initial, 'c1');
    expect(byConversationId.other).toBe(initial.other);
  });

  it('given pending mutations recorded under the previous generation, should reset them on a new startLoad', () => {
    const initial: ConversationMessagesById = {
      c1: {
        messages: [],
        optimisticSends: [],
        loadGeneration: 1,
        pendingMutationsSinceLoad: [{ type: 'remoteMessage', message: { id: 'm1', role: 'user', parts: [] } }],
        loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false,
      },
    };
    const { byConversationId } = applyStartLoad(initial, 'c1');
    expect(byConversationId.c1.pendingMutationsSinceLoad).toEqual([]);
  });

  // PR 6 review (CodeRabbit): a "load older" fetch in flight when a full reload starts
  // becomes stale (its eventual settle is a no-op against the new generation) and would
  // never itself clear isLoadingOlder — leaving future "load older" fetches permanently
  // blocked unless startLoad resets it here.
  it('given isLoadingOlder is true from an in-flight "load older" fetch, should reset it to false on a new startLoad', () => {
    const initial: ConversationMessagesById = {
      c1: {
        messages: [],
        optimisticSends: [],
        loadGeneration: 1,
        pendingMutationsSinceLoad: [],
        loadStatus: 'loaded', olderCursor: 'cursor-1', hasMoreOlder: true, isLoadingOlder: true,
      },
    };
    const { byConversationId } = applyStartLoad(initial, 'c1');
    expect(byConversationId.c1.isLoadingOlder).toBe(false);
  });
});

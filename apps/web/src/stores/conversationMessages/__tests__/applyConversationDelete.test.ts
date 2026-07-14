import { describe, it, expect } from 'vitest';
import { applyConversationDelete } from '../applyConversationDelete';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

describe('applyConversationDelete', () => {
  it('given a matching id in confirmed messages, should remove it', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1'), msg('m2')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [] },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'm1' });
    expect(result.c1.messages).toEqual([msg('m2')]);
  });

  it('given a matching id in optimisticSends, should remove it from there too', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1')], loadGeneration: 0, pendingMutationsSinceLoad: [] },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'opt1' });
    expect(result.c1.optimisticSends).toEqual([]);
  });

  it('given an id present in neither, should no-op and return the same reference', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [] },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'missing' });
    expect(result).toBe(initial);
  });

  it('given a conversation not tracked at all, should no-op', () => {
    const result = applyConversationDelete({}, { conversationId: 'c1', messageId: 'm1' });
    expect(result).toEqual({});
  });

  it('given an actual delete of a confirmed message, should record it in pendingMutationsSinceLoad so an in-flight load can replay it', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [] },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'm1' });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([{ type: 'delete', messageId: 'm1' }]);
  });

  it('given a delete that only removed an optimistic (unconfirmed) send, should NOT record a pending mutation (it can never appear in a DB snapshot)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1')], loadGeneration: 0, pendingMutationsSinceLoad: [] },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'opt1' });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([]);
  });

  it('given a no-op delete (id present in neither array), should not record a pending mutation', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [] },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'missing' });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([]);
  });

  it('given an actual delete, should NOT bump loadGeneration (a fresh load already reflecting this delete must not be invalidated)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [] },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'm1' });
    expect(result.c1.loadGeneration).toBe(1);
  });
});

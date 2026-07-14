import { describe, it, expect } from 'vitest';
import { applyConversationDelete } from '../applyConversationDelete';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

describe('applyConversationDelete', () => {
  it('given a matching id in confirmed messages, should remove it', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1'), msg('m2')], optimisticSends: [], loadGeneration: 1 },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'm1' });
    expect(result.c1.messages).toEqual([msg('m2')]);
  });

  it('given a matching id in optimisticSends, should remove it from there too', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1')], loadGeneration: 0 },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'opt1' });
    expect(result.c1.optimisticSends).toEqual([]);
  });

  it('given an id present in neither, should no-op and return the same reference', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1')], optimisticSends: [], loadGeneration: 1 },
    };
    const result = applyConversationDelete(initial, { conversationId: 'c1', messageId: 'missing' });
    expect(result).toBe(initial);
  });

  it('given a conversation not tracked at all, should no-op', () => {
    const result = applyConversationDelete({}, { conversationId: 'c1', messageId: 'm1' });
    expect(result).toEqual({});
  });
});

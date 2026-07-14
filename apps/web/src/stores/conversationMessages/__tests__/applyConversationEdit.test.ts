import { describe, it, expect } from 'vitest';
import { applyConversationEdit } from '../applyConversationEdit';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });

describe('applyConversationEdit', () => {
  it('given a matching messageId in a tracked conversation, should replace its parts and stamp editedAt', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1', 'old')], optimisticSends: [], loadGeneration: 1 },
    };
    const editedAt = new Date('2024-01-01T00:00:00.000Z');
    const result = applyConversationEdit(initial, {
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'new' }], editedAt },
    });
    expect(result.c1.messages[0]).toMatchObject({ id: 'm1', parts: [{ type: 'text', text: 'new' }], editedAt });
  });

  it('given a messageId not present, should no-op and return the same reference', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1', 'old')], optimisticSends: [], loadGeneration: 1 },
    };
    const result = applyConversationEdit(initial, {
      conversationId: 'c1',
      payload: { messageId: 'missing', parts: [], editedAt: new Date() },
    });
    expect(result).toBe(initial);
  });

  it('given a conversation not tracked at all, should no-op', () => {
    const result = applyConversationEdit(
      {},
      { conversationId: 'c1', payload: { messageId: 'm1', parts: [], editedAt: new Date() } },
    );
    expect(result).toEqual({});
  });

  it('given other conversations tracked, should not touch them', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1', 'old')], optimisticSends: [], loadGeneration: 1 },
      other: { messages: [msg('x', 'y')], optimisticSends: [], loadGeneration: 1 },
    };
    const result = applyConversationEdit(initial, {
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'new' }], editedAt: new Date() },
    });
    expect(result.other).toBe(initial.other);
  });

  it('given an actual edit, should bump loadGeneration so an in-flight load snapshotted before this edit cannot later clobber it', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1', 'old')], optimisticSends: [], loadGeneration: 1 },
    };
    const result = applyConversationEdit(initial, {
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'new' }], editedAt: new Date() },
    });
    expect(result.c1.loadGeneration).toBe(2);
  });

  it('given a no-op edit (messageId not present), should not bump loadGeneration', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1', 'old')], optimisticSends: [], loadGeneration: 1 },
    };
    const result = applyConversationEdit(initial, {
      conversationId: 'c1',
      payload: { messageId: 'missing', parts: [], editedAt: new Date() },
    });
    expect(result.c1.loadGeneration).toBe(1);
  });
});

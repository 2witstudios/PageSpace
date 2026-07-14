import { describe, it, expect } from 'vitest';
import { applyConversationEdit } from '../applyConversationEdit';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] });

describe('applyConversationEdit', () => {
  it('given a matching messageId in a tracked conversation, should replace its parts and stamp editedAt', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1', 'old')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [] },
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
      c1: { messages: [msg('m1', 'old')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [] },
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
      c1: { messages: [msg('m1', 'old')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [] },
      other: { messages: [msg('x', 'y')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [] },
    };
    const result = applyConversationEdit(initial, {
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'new' }], editedAt: new Date() },
    });
    expect(result.other).toBe(initial.other);
  });

  it('given an actual edit, should record it in pendingMutationsSinceLoad so an in-flight load can replay it', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1', 'old')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [] },
    };
    const editedAt = new Date('2024-01-01T00:00:00.000Z');
    const result = applyConversationEdit(initial, {
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'new' }], editedAt },
    });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([
      { type: 'edit', payload: { messageId: 'm1', parts: [{ type: 'text', text: 'new' }], editedAt } },
    ]);
  });

  it('given a no-op edit (messageId not present), should not record a pending mutation', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1', 'old')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [] },
    };
    const result = applyConversationEdit(initial, {
      conversationId: 'c1',
      payload: { messageId: 'missing', parts: [], editedAt: new Date() },
    });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([]);
  });

  it('given an actual edit, should NOT bump loadGeneration (a fresh load already covering this edit must not be invalidated)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1', 'old')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [] },
    };
    const result = applyConversationEdit(initial, {
      conversationId: 'c1',
      payload: { messageId: 'm1', parts: [{ type: 'text', text: 'new' }], editedAt: new Date() },
    });
    expect(result.c1.loadGeneration).toBe(1);
  });
});

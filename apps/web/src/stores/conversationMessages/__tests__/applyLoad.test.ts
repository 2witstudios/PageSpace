import { describe, it, expect } from 'vitest';
import { applyLoad } from '../applyLoad';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

describe('applyLoad', () => {
  it('given the current generation, should replace messages with the loaded set', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('old')], optimisticSends: [], loadGeneration: 1 },
    };
    const result = applyLoad(initial, { conversationId: 'c1', generation: 1, messages: [msg('m1'), msg('m2')] });
    expect(result.c1.messages).toEqual([msg('m1'), msg('m2')]);
  });

  it('given a stale generation (a newer load has since started), should no-op and return the same reference', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('old')], optimisticSends: [], loadGeneration: 2 },
    };
    const result = applyLoad(initial, { conversationId: 'c1', generation: 1, messages: [msg('m1')] });
    expect(result).toBe(initial);
  });

  it('given a conversation never started via startLoad, should no-op', () => {
    const result = applyLoad({}, { conversationId: 'c1', generation: 1, messages: [msg('m1')] });
    expect(result).toEqual({});
  });

  it('given an optimistic send whose id now appears in the loaded set, should reconcile it out of optimisticSends', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1'), msg('opt2')], loadGeneration: 1 },
    };
    const result = applyLoad(initial, {
      conversationId: 'c1',
      generation: 1,
      messages: [msg('opt1')],
    });
    expect(result.c1.optimisticSends).toEqual([msg('opt2')]);
  });

  it('given no optimistic sends match the loaded set, should leave optimisticSends untouched', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [msg('opt1')], loadGeneration: 1 },
    };
    const result = applyLoad(initial, { conversationId: 'c1', generation: 1, messages: [msg('m1')] });
    expect(result.c1.optimisticSends).toEqual([msg('opt1')]);
  });

  it('given a fresh load, should preserve the loadGeneration value', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [], loadGeneration: 5 },
    };
    const result = applyLoad(initial, { conversationId: 'c1', generation: 5, messages: [msg('m1')] });
    expect(result.c1.loadGeneration).toBe(5);
  });

  it('given other conversations tracked, should not touch them', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [], loadGeneration: 1 },
      other: { messages: [msg('x')], optimisticSends: [], loadGeneration: 9 },
    };
    const result = applyLoad(initial, { conversationId: 'c1', generation: 1, messages: [] });
    expect(result.other).toBe(initial.other);
  });
});

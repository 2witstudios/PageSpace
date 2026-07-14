import { describe, it, expect } from 'vitest';
import { applyFailLoad } from '../applyFailLoad';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

describe('applyFailLoad', () => {
  it('given an entry with existing messages, should keep them unchanged (never clear to empty on a failed reload)', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1'), msg('m2')], optimisticSends: [msg('opt1')], loadGeneration: 2 },
    };
    const result = applyFailLoad(initial, { conversationId: 'c1', generation: 2 });
    expect(result).toBe(initial);
    expect(result.c1.messages).toEqual([msg('m1'), msg('m2')]);
    expect(result.c1.optimisticSends).toEqual([msg('opt1')]);
  });

  it('given a stale generation, should also keep prior state unchanged', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [msg('m1')], optimisticSends: [], loadGeneration: 3 },
    };
    const result = applyFailLoad(initial, { conversationId: 'c1', generation: 1 });
    expect(result).toBe(initial);
  });

  it('given a conversation not tracked at all, should no-op safely', () => {
    const result = applyFailLoad({}, { conversationId: 'unknown', generation: 1 });
    expect(result).toEqual({});
  });
});

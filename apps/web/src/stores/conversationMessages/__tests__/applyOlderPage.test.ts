import { describe, it, expect } from 'vitest';
import { applyOlderPage } from '../applyOlderPage';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const msg = (id: string): UIMessage => ({ id, role: 'user', parts: [] });

const baseEntry = {
  optimisticSends: [] as UIMessage[],
  loadGeneration: 1,
  pendingMutationsSinceLoad: [],
  loadStatus: 'loaded' as const,
  isLoadingOlder: true,
};

describe('applyOlderPage', () => {
  it('given the current generation, should PREPEND the older page before existing messages', () => {
    const initial: ConversationMessagesById = {
      c1: { ...baseEntry, messages: [msg('m1'), msg('m2')], olderCursor: 'm1', hasMoreOlder: true },
    };
    const result = applyOlderPage(initial, {
      conversationId: 'c1',
      generation: 1,
      messages: [msg('older1'), msg('older2')],
      hasMoreOlder: true,
      nextCursor: 'older1',
    });
    expect(result.c1.messages).toEqual([msg('older1'), msg('older2'), msg('m1'), msg('m2')]);
  });

  it('given a stale generation (a reload started meanwhile), should no-op and return the same reference', () => {
    const initial: ConversationMessagesById = {
      c1: { ...baseEntry, messages: [msg('m1')], loadGeneration: 2, olderCursor: 'm1', hasMoreOlder: true },
    };
    const result = applyOlderPage(initial, {
      conversationId: 'c1',
      generation: 1,
      messages: [msg('older1')],
      hasMoreOlder: true,
      nextCursor: 'older1',
    });
    expect(result).toBe(initial);
  });

  it('given a conversation not tracked at all, should no-op', () => {
    const result = applyOlderPage({}, {
      conversationId: 'c1',
      generation: 1,
      messages: [msg('older1')],
      hasMoreOlder: true,
      nextCursor: 'older1',
    });
    expect(result).toEqual({});
  });

  it('given an older message that arrived via socket edit/undo while the fetch was in flight, should dedup it out (by id) rather than duplicate', () => {
    const initial: ConversationMessagesById = {
      c1: { ...baseEntry, messages: [msg('dup'), msg('m2')], olderCursor: 'dup', hasMoreOlder: true },
    };
    const result = applyOlderPage(initial, {
      conversationId: 'c1',
      generation: 1,
      messages: [msg('older1'), msg('dup')],
      hasMoreOlder: false,
      nextCursor: null,
    });
    expect(result.c1.messages).toEqual([msg('older1'), msg('dup'), msg('m2')]);
  });

  it('should advance olderCursor/hasMoreOlder from the response', () => {
    const initial: ConversationMessagesById = {
      c1: { ...baseEntry, messages: [msg('m1')], olderCursor: 'm1', hasMoreOlder: true },
    };
    const result = applyOlderPage(initial, {
      conversationId: 'c1',
      generation: 1,
      messages: [msg('older1')],
      hasMoreOlder: false,
      nextCursor: null,
    });
    expect(result.c1.olderCursor).toBeNull();
    expect(result.c1.hasMoreOlder).toBe(false);
  });

  it('should clear isLoadingOlder on success', () => {
    const initial: ConversationMessagesById = {
      c1: { ...baseEntry, messages: [msg('m1')], olderCursor: 'm1', hasMoreOlder: true, isLoadingOlder: true },
    };
    const result = applyOlderPage(initial, {
      conversationId: 'c1',
      generation: 1,
      messages: [msg('older1')],
      hasMoreOlder: true,
      nextCursor: 'older1',
    });
    expect(result.c1.isLoadingOlder).toBe(false);
  });

  it('should preserve optimisticSends untouched', () => {
    const initial: ConversationMessagesById = {
      c1: { ...baseEntry, messages: [msg('m1')], optimisticSends: [msg('opt1')], olderCursor: 'm1', hasMoreOlder: true },
    };
    const result = applyOlderPage(initial, {
      conversationId: 'c1',
      generation: 1,
      messages: [msg('older1')],
      hasMoreOlder: true,
      nextCursor: 'older1',
    });
    expect(result.c1.optimisticSends).toEqual([msg('opt1')]);
  });

  it('given other conversations tracked, should not touch them', () => {
    const initial: ConversationMessagesById = {
      c1: { ...baseEntry, messages: [msg('m1')], olderCursor: 'm1', hasMoreOlder: true },
      other: { ...baseEntry, messages: [msg('x')], olderCursor: null, hasMoreOlder: false },
    };
    const result = applyOlderPage(initial, {
      conversationId: 'c1',
      generation: 1,
      messages: [msg('older1')],
      hasMoreOlder: true,
      nextCursor: 'older1',
    });
    expect(result.other).toBe(initial.other);
  });
});

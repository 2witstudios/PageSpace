import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { applyConversationToolApprovalResponse } from '../applyConversationToolApprovalResponse';
import type { ConversationMessagesById } from '../seedEmpty';

const paused = (toolCallId: string) => ({ type: 'tool-trash_page', toolCallId, state: 'approval-requested', input: {}, approval: { id: `ap-${toolCallId}` } });
const assistantMsg = (id: string, toolCallId: string): UIMessage => ({ id, role: 'assistant', parts: [paused(toolCallId)] }) as unknown as UIMessage;
const entry = (messages: UIMessage[]) => ({ messages, optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded' as const, olderCursor: null, hasMoreOlder: false, isLoadingOlder: false, rev: null });
const payload = { messageId: 'a1', toolCallId: 'tc1', approval: { id: 'ap-tc1', approved: true } };

describe('applyConversationToolApprovalResponse', () => {
  it('patches the paused part to approval-responded and records the mutation for a racing load', () => {
    const initial: ConversationMessagesById = { c1: entry([assistantMsg('a1', 'tc1')]) };
    const result = applyConversationToolApprovalResponse(initial, { conversationId: 'c1', payload });
    expect(result.c1.messages[0].parts[0]).toMatchObject({ state: 'approval-responded', approval: { id: 'ap-tc1', approved: true } });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([{ type: 'toolApprovalResponse', payload }]);
  });

  it('no-ops for an untracked conversation and leaves other conversations by reference', () => {
    expect(applyConversationToolApprovalResponse({}, { conversationId: 'c1', payload })).toEqual({});
    const initial: ConversationMessagesById = { c1: entry([assistantMsg('a1', 'tc1')]), other: entry([assistantMsg('a2', 'tc2')]) };
    const result = applyConversationToolApprovalResponse(initial, { conversationId: 'c1', payload });
    expect(result.other).toBe(initial.other);
  });

  it('records the mutation even when the message is not loaded yet, so the load cannot resurrect the pause', () => {
    const initial: ConversationMessagesById = { c1: entry([]) };
    const result = applyConversationToolApprovalResponse(initial, { conversationId: 'c1', payload });
    expect(result.c1.messages).toEqual([]);
    expect(result.c1.pendingMutationsSinceLoad).toEqual([{ type: 'toolApprovalResponse', payload }]);
  });
});

import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { applyConversationToolApprovalResponse } from '../applyConversationToolApprovalResponse';
import { revertConversationToolApprovalResponse } from '../revertConversationToolApprovalResponse';
import type { ConversationMessagesById } from '../seedEmpty';

const paused = (toolCallId: string) => ({ type: 'tool-trash_page', toolCallId, state: 'approval-requested', input: {}, approval: { id: `ap-${toolCallId}` } });
const assistantMsg = (id: string, toolCallId: string): UIMessage => ({ id, role: 'assistant', parts: [paused(toolCallId)] }) as unknown as UIMessage;
const entry = (messages: UIMessage[]) => ({ messages, optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded' as const, olderCursor: null, hasMoreOlder: false, isLoadingOlder: false, rev: null });
const payload = { messageId: 'a1', toolCallId: 'tc1', approval: { id: 'ap-tc1', approved: true } };

describe('revertConversationToolApprovalResponse', () => {
  it('puts the part back to approval-requested AND retracts the recorded mutation, so a racing load cannot replay the withdrawn answer', () => {
    const initial: ConversationMessagesById = { c1: entry([assistantMsg('a1', 'tc1')]) };
    const answered = applyConversationToolApprovalResponse(initial, { conversationId: 'c1', payload });
    const result = revertConversationToolApprovalResponse(answered, { conversationId: 'c1', payload: { messageId: 'a1', toolCallId: 'tc1' } });
    expect(result.c1.messages[0].parts[0]).toMatchObject({ state: 'approval-requested', approval: { id: 'ap-tc1' } });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([]);
  });

  it('retracts only the mutation for that call; other recorded mutations stay', () => {
    const initial: ConversationMessagesById = { c1: entry([assistantMsg('a1', 'tc1'), assistantMsg('a2', 'tc2')]) };
    const other = { messageId: 'a2', toolCallId: 'tc2', approval: { id: 'ap-tc2', approved: false } };
    const answered = applyConversationToolApprovalResponse(
      applyConversationToolApprovalResponse(initial, { conversationId: 'c1', payload }),
      { conversationId: 'c1', payload: other },
    );
    const result = revertConversationToolApprovalResponse(answered, { conversationId: 'c1', payload: { messageId: 'a1', toolCallId: 'tc1' } });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([{ type: 'toolApprovalResponse', payload: other }]);
    expect(result.c1.messages[1].parts[0]).toMatchObject({ state: 'approval-responded' });
  });

  it('no-ops for an untracked conversation and leaves other conversations by reference', () => {
    expect(revertConversationToolApprovalResponse({}, { conversationId: 'c1', payload: { messageId: 'a1', toolCallId: 'tc1' } })).toEqual({});
    const initial: ConversationMessagesById = { c1: entry([assistantMsg('a1', 'tc1')]), other: entry([assistantMsg('a2', 'tc2')]) };
    const result = revertConversationToolApprovalResponse(initial, { conversationId: 'c1', payload: { messageId: 'a1', toolCallId: 'tc1' } });
    expect(result.other).toBe(initial.other);
  });
});

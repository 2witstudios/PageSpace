import { describe, it, expect } from 'vitest';
import { applyConversationAskUserAnswer } from '../applyConversationAskUserAnswer';
import type { ConversationMessagesById } from '../seedEmpty';
import type { UIMessage } from 'ai';

const askUserPart = (toolCallId: string, state: string) => ({
  type: 'tool-ask_user',
  toolCallId,
  state,
  input: { questions: [] },
});

const assistantMsg = (id: string, toolCallId: string, state: string): UIMessage =>
  ({ id, role: 'assistant', parts: [askUserPart(toolCallId, state)] } as UIMessage);

describe('applyConversationAskUserAnswer', () => {
  it('given a matching message in a tracked conversation, should patch the tool part to output-available', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [assistantMsg('a1', 'tc1', 'input-available')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConversationAskUserAnswer(initial, {
      conversationId: 'c1',
      payload: { messageId: 'a1', toolCallId: 'tc1', output: { answers: [] } },
    });
    expect(result.c1.messages[0].parts[0]).toMatchObject({ state: 'output-available', output: { answers: [] } });
  });

  it('given a conversation not tracked at all, should no-op', () => {
    const result = applyConversationAskUserAnswer(
      {},
      { conversationId: 'c1', payload: { messageId: 'a1', toolCallId: 'tc1', output: { answers: [] } } },
    );
    expect(result).toEqual({});
  });

  it('given other conversations tracked, should not touch them', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [assistantMsg('a1', 'tc1', 'input-available')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
      other: { messages: [assistantMsg('a2', 'tc2', 'input-available')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConversationAskUserAnswer(initial, {
      conversationId: 'c1',
      payload: { messageId: 'a1', toolCallId: 'tc1', output: { answers: [] } },
    });
    expect(result.other).toBe(initial.other);
  });

  it('given an answer, should record it in pendingMutationsSinceLoad so a racing load replays it', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [assistantMsg('a1', 'tc1', 'input-available')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConversationAskUserAnswer(initial, {
      conversationId: 'c1',
      payload: { messageId: 'a1', toolCallId: 'tc1', output: { answers: [] } },
    });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([
      { type: 'askUserAnswer', payload: { messageId: 'a1', toolCallId: 'tc1', output: { answers: [] } } },
    ]);
  });

  it('given an answer for a message not present yet, should STILL record the pending mutation for later replay', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConversationAskUserAnswer(initial, {
      conversationId: 'c1',
      payload: { messageId: 'not-yet-loaded', toolCallId: 'tc1', output: { answers: [] } },
    });
    expect(result.c1.pendingMutationsSinceLoad).toEqual([
      { type: 'askUserAnswer', payload: { messageId: 'not-yet-loaded', toolCallId: 'tc1', output: { answers: [] } } },
    ]);
  });

  it('given an answer, should NOT bump loadGeneration', () => {
    const initial: ConversationMessagesById = {
      c1: { messages: [assistantMsg('a1', 'tc1', 'input-available')], optimisticSends: [], loadGeneration: 1, pendingMutationsSinceLoad: [], loadStatus: 'loaded', olderCursor: null, hasMoreOlder: false, isLoadingOlder: false },
    };
    const result = applyConversationAskUserAnswer(initial, {
      conversationId: 'c1',
      payload: { messageId: 'a1', toolCallId: 'tc1', output: { answers: [] } },
    });
    expect(result.c1.loadGeneration).toBe(1);
  });
});

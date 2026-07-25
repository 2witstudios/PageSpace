import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { getAnswerableAskUserToolCallIds } from '../useAskUserAnswering';

const assistantMessage = (parts: Array<Record<string, unknown>>): UIMessage =>
  ({ id: 'a1', role: 'assistant', parts } as unknown as UIMessage);

describe('getAnswerableAskUserToolCallIds', () => {
  it('given ask_user on the last assistant message with input-available, should mark it answerable', () => {
    const ids = getAnswerableAskUserToolCallIds([
      assistantMessage([
        { type: 'tool-ask_user', toolCallId: 'q1', state: 'input-available', input: { questions: [] } },
      ]),
    ]);

    expect(ids.has('q1')).toBe(true);
  });

  it('given ask_user not on the last message, should return no answerable ids', () => {
    const ids = getAnswerableAskUserToolCallIds([
      assistantMessage([
        { type: 'tool-ask_user', toolCallId: 'q1', state: 'input-available', input: { questions: [] } },
      ]),
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'later message' }] } as unknown as UIMessage,
    ]);

    expect(ids.size).toBe(0);
  });

  it('given ask_user already output-available, should return no answerable ids', () => {
    const ids = getAnswerableAskUserToolCallIds([
      assistantMessage([
        { type: 'tool-ask_user', toolCallId: 'q1', state: 'output-available', output: { answers: [] } },
      ]),
    ]);

    expect(ids.size).toBe(0);
  });
});

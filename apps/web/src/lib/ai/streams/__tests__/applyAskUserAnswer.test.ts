import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { applyAskUserAnswer, revertAskUserAnswer } from '../applyAskUserAnswer';

const askUserPart = (toolCallId: string, state: string, extra: Record<string, unknown> = {}) => ({
  type: 'tool-ask_user',
  toolCallId,
  state,
  input: { questions: [] },
  ...extra,
});

const assistantMessage = (id: string, parts: unknown[]): UIMessage =>
  ({ id, role: 'assistant', parts } as UIMessage);

describe('applyAskUserAnswer', () => {
  it('given a matching messageId and toolCallId, should patch the part to output-available with the answer', () => {
    const messages = [assistantMessage('a1', [askUserPart('tc1', 'input-available')])];
    const result = applyAskUserAnswer(messages, {
      messageId: 'a1',
      toolCallId: 'tc1',
      output: { answers: [{ header: 'H', question: 'Q', selectedLabel: 'Yes' }] },
    });
    expect(result[0].parts[0]).toMatchObject({
      state: 'output-available',
      output: { answers: [{ header: 'H', question: 'Q', selectedLabel: 'Yes' }] },
    });
  });

  it('given no matching messageId, should return the input reference unchanged', () => {
    const messages = [assistantMessage('a1', [askUserPart('tc1', 'input-available')])];
    const result = applyAskUserAnswer(messages, {
      messageId: 'missing',
      toolCallId: 'tc1',
      output: { answers: [] },
    });
    expect(result).toBe(messages);
  });

  it('given no matching toolCallId on the message, should return the input reference unchanged', () => {
    const messages = [assistantMessage('a1', [askUserPart('tc1', 'input-available')])];
    const result = applyAskUserAnswer(messages, {
      messageId: 'a1',
      toolCallId: 'other',
      output: { answers: [] },
    });
    expect(result).toBe(messages);
  });

  it('given multiple parts, should leave sibling parts untouched', () => {
    const messages = [
      assistantMessage('a1', [
        { type: 'text', text: 'hello' },
        askUserPart('tc1', 'input-available'),
      ]),
    ];
    const result = applyAskUserAnswer(messages, {
      messageId: 'a1',
      toolCallId: 'tc1',
      output: { answers: [] },
    });
    expect(result[0].parts[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('given a matching message with no parts array at all (undefined), should return the input reference unchanged', () => {
    const messages = [{ id: 'a1', role: 'assistant' } as UIMessage];
    const result = applyAskUserAnswer(messages, {
      messageId: 'a1',
      toolCallId: 'tc1',
      output: { answers: [] },
    });
    expect(result).toBe(messages);
  });

  it('given multiple messages, should leave sibling messages untouched (reference equality)', () => {
    const other = assistantMessage('a2', [askUserPart('tc2', 'input-available')]);
    const messages = [assistantMessage('a1', [askUserPart('tc1', 'input-available')]), other];
    const result = applyAskUserAnswer(messages, {
      messageId: 'a1',
      toolCallId: 'tc1',
      output: { answers: [] },
    });
    expect(result[1]).toBe(other);
  });
});

describe('revertAskUserAnswer', () => {
  it('given an answered part, should revert it to input-available with no output', () => {
    const messages = [
      assistantMessage('a1', [askUserPart('tc1', 'output-available', { output: { answers: [] } })]),
    ];
    const result = revertAskUserAnswer(messages, { messageId: 'a1', toolCallId: 'tc1' });
    expect(result[0].parts[0]).toMatchObject({ state: 'input-available' });
    expect((result[0].parts[0] as Record<string, unknown>).output).toBeUndefined();
  });

  it('given no matching messageId, should return the input reference unchanged', () => {
    const messages = [
      assistantMessage('a1', [askUserPart('tc1', 'output-available', { output: { answers: [] } })]),
    ];
    const result = revertAskUserAnswer(messages, { messageId: 'missing', toolCallId: 'tc1' });
    expect(result).toBe(messages);
  });
});

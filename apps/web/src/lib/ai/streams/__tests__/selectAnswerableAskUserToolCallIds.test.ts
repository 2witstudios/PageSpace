import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import type { RenderedMessage } from '../selectRenderedMessages';
import { selectAnswerableAskUserToolCallIds } from '../selectAnswerableAskUserToolCallIds';

const askUserPart = (toolCallId: string, state: string) => ({
  type: 'tool-ask_user',
  toolCallId,
  state,
  input: { questions: [] },
});

const msg = (id: string, role: UIMessage['role'], parts: unknown[] = []): UIMessage =>
  ({ id, role, parts } as UIMessage);

const confirmed = (message: UIMessage): RenderedMessage => ({ message, mode: 'confirmed' });
const streaming = (message: UIMessage): RenderedMessage => ({ message, mode: 'streaming' });

const base = { answeringToolCallIds: new Set<string>(), isConversationBusy: false };

describe('selectAnswerableAskUserToolCallIds', () => {
  it('given an input-available ask_user part on the last assistant message, should be answerable', () => {
    const rendered = [confirmed(msg('a1', 'assistant', [askUserPart('tc1', 'input-available')]))];
    expect(selectAnswerableAskUserToolCallIds({ ...base, renderedMessages: rendered })).toEqual(
      new Set(['tc1']),
    );
  });

  it('given the conversation is busy (active stream or pending send), should answer nothing', () => {
    const rendered = [confirmed(msg('a1', 'assistant', [askUserPart('tc1', 'input-available')]))];
    expect(
      selectAnswerableAskUserToolCallIds({ ...base, renderedMessages: rendered, isConversationBusy: true }),
    ).toEqual(new Set());
  });

  it('given the toolCallId is already in the in-flight set, should exclude it (idempotency across co-mounted surfaces)', () => {
    const rendered = [confirmed(msg('a1', 'assistant', [askUserPart('tc1', 'input-available')]))];
    expect(
      selectAnswerableAskUserToolCallIds({
        ...base,
        renderedMessages: rendered,
        answeringToolCallIds: new Set(['tc1']),
      }),
    ).toEqual(new Set());
  });

  it('given the part is NOT on the last message, should exclude it', () => {
    const rendered = [
      confirmed(msg('a1', 'assistant', [askUserPart('tc1', 'input-available')])),
      confirmed(msg('u1', 'user')),
    ];
    expect(selectAnswerableAskUserToolCallIds({ ...base, renderedMessages: rendered })).toEqual(new Set());
  });

  it('given the last message is a streaming synthesized row, should exclude it (not a real assistant answer state)', () => {
    const rendered = [streaming(msg('a1', 'assistant', [askUserPart('tc1', 'input-available')]))];
    expect(selectAnswerableAskUserToolCallIds({ ...base, renderedMessages: rendered })).toEqual(new Set());
  });

  it('given the part state is output-available (already answered), should exclude it', () => {
    const rendered = [confirmed(msg('a1', 'assistant', [askUserPart('tc1', 'output-available')]))];
    expect(selectAnswerableAskUserToolCallIds({ ...base, renderedMessages: rendered })).toEqual(new Set());
  });

  it('given multiple ask_user parts on the last message, should include every input-available one', () => {
    const rendered = [
      confirmed(
        msg('a1', 'assistant', [askUserPart('tc1', 'input-available'), askUserPart('tc2', 'input-available')]),
      ),
    ];
    expect(selectAnswerableAskUserToolCallIds({ ...base, renderedMessages: rendered })).toEqual(
      new Set(['tc1', 'tc2']),
    );
  });

  it('given an empty rendered list, should answer nothing', () => {
    expect(selectAnswerableAskUserToolCallIds({ ...base, renderedMessages: [] })).toEqual(new Set());
  });

  it('given the last assistant message has no parts field at all (undefined), should answer nothing without throwing', () => {
    const rendered = [confirmed({ id: 'a1', role: 'assistant' } as UIMessage)];
    expect(selectAnswerableAskUserToolCallIds({ ...base, renderedMessages: rendered })).toEqual(new Set());
  });
});

import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import type { RenderedMessage } from '../selectRenderedMessages';
import { selectAnswerableApprovalToolCallIds } from '../selectAnswerableApprovalToolCallIds';

const paused = (toolCallId: string, state = 'approval-requested') => ({
  type: 'tool-trash_page',
  toolCallId,
  state,
  input: {},
  approval: { id: `ap-${toolCallId}` },
});

const msg = (id: string, role: UIMessage['role'], parts?: unknown[]): UIMessage =>
  ({ id, role, ...(parts ? { parts } : {}) }) as UIMessage;

const confirmed = (message: UIMessage): RenderedMessage => ({ message, mode: 'confirmed' });
const streaming = (message: UIMessage): RenderedMessage => ({ message, mode: 'streaming' });

const base = { answeringToolCallIds: new Set<string>(), isConversationBusy: false };

describe('selectAnswerableApprovalToolCallIds', () => {
  it('given approval-requested parts on the last assistant message, should answer them all (whatever the tool)', () => {
    const rendered = [confirmed(msg('a1', 'assistant', [paused('tc1'), { ...paused('tc2'), type: 'tool-execute_tool' }, { type: 'text', text: 'x' }]))];
    expect(selectAnswerableApprovalToolCallIds({ ...base, renderedMessages: rendered })).toEqual(new Set(['tc1', 'tc2']));
  });

  it('given the conversation is busy, should answer nothing', () => {
    const rendered = [confirmed(msg('a1', 'assistant', [paused('tc1')]))];
    expect(selectAnswerableApprovalToolCallIds({ ...base, renderedMessages: rendered, isConversationBusy: true })).toEqual(new Set());
  });

  it('given the toolCallId is already claimed by another surface, should exclude it', () => {
    const rendered = [confirmed(msg('a1', 'assistant', [paused('tc1'), paused('tc2')]))];
    expect(selectAnswerableApprovalToolCallIds({ ...base, renderedMessages: rendered, answeringToolCallIds: new Set(['tc1']) })).toEqual(new Set(['tc2']));
  });

  it('given the part is not on the last settled message, should exclude it (a streaming tail does not count)', () => {
    expect(
      selectAnswerableApprovalToolCallIds({
        ...base,
        renderedMessages: [confirmed(msg('a1', 'assistant', [paused('tc1')])), confirmed(msg('u1', 'user', []))],
      }),
    ).toEqual(new Set());
    expect(
      selectAnswerableApprovalToolCallIds({
        ...base,
        renderedMessages: [confirmed(msg('a1', 'assistant', [paused('tc1')])), streaming(msg('a2', 'assistant', []))],
      }),
    ).toEqual(new Set(['tc1']));
  });

  it('given a part that is responded or otherwise not paused, should exclude it', () => {
    const rendered = [confirmed(msg('a1', 'assistant', [paused('tc1', 'approval-responded'), paused('tc2', 'output-available')]))];
    expect(selectAnswerableApprovalToolCallIds({ ...base, renderedMessages: rendered })).toEqual(new Set());
  });

  it('given no messages, or a last message with no parts array, should answer nothing', () => {
    expect(selectAnswerableApprovalToolCallIds({ ...base, renderedMessages: [] })).toEqual(new Set());
    expect(selectAnswerableApprovalToolCallIds({ ...base, renderedMessages: [confirmed(msg('a1', 'assistant'))] })).toEqual(new Set());
  });
});

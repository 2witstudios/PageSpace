import { describe, it } from 'vitest';
import type { UIMessage } from 'ai';
import { assert } from '@/lib/ai/core/__tests__/riteway';
import { isPendingApprovalPart, isRespondedApprovalPart, toolApprovalsComplete } from '../approval-client';

type Part = UIMessage['parts'][number];
const requested = (id: string): Part =>
  ({ type: 'tool-trash_page', toolCallId: id, state: 'approval-requested', input: {}, approval: { id: `ap-${id}` } }) as unknown as Part;
const responded = (id: string, approved = true): Part =>
  ({ type: 'tool-trash_page', toolCallId: id, state: 'approval-responded', input: {}, approval: { id: `ap-${id}`, approved } }) as unknown as Part;
const finished = (): Part =>
  ({ type: 'tool-finish', toolCallId: 'f', state: 'output-available', input: {}, output: {} }) as unknown as Part;
const assistant = (parts: Part[]): UIMessage => ({ id: 'a1', role: 'assistant', parts });
const user = (): UIMessage => ({ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] });

describe('toolApprovalsComplete', () => {
  it('is true only when every approval part on the last assistant message is responded', () => {
    assert({ given: 'one responded', should: 'be true', actual: toolApprovalsComplete({ messages: [user(), assistant([responded('a')])] }), expected: true });
    assert({ given: 'one responded, one still pending', should: 'be false', actual: toolApprovalsComplete({ messages: [user(), assistant([responded('a'), requested('b')])] }), expected: false });
    assert({ given: 'two responded (one denied)', should: 'be true', actual: toolApprovalsComplete({ messages: [user(), assistant([responded('a'), responded('b', false)])] }), expected: true });
  });

  it('is false for a turn with no approval parts, even though finish is output-available (never loop on finish)', () => {
    assert({ given: 'finish only', should: 'be false', actual: toolApprovalsComplete({ messages: [user(), assistant([finished()])] }), expected: false });
  });

  it('is false when the last message is not an assistant message, or there are none', () => {
    assert({ given: 'last is user', should: 'be false', actual: toolApprovalsComplete({ messages: [assistant([responded('a')]), user()] }), expected: false });
    assert({ given: 'empty', should: 'be false', actual: toolApprovalsComplete({ messages: [] }), expected: false });
  });

  it('a responded part without a boolean answer does not count as responded', () => {
    const half = { type: 'tool-trash_page', toolCallId: 'x', state: 'approval-responded', approval: { id: 'ap-x' } } as unknown as Part;
    assert({ given: 'approval-responded with no approved flag', should: 'not be responded', actual: isRespondedApprovalPart(half), expected: false });
    assert({ given: 'approval-requested', should: 'be pending', actual: isPendingApprovalPart(requested('y')), expected: true });
  });
});

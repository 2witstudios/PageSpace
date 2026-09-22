import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { applyToolApprovalResponse, revertToolApprovalResponse } from '../applyToolApprovalResponse';

const paused = (toolCallId: string, approvalId: string) =>
  ({ type: 'tool-trash_page', toolCallId, state: 'approval-requested', input: { pageId: 'p' }, approval: { id: approvalId } });
const msg = (id: string, parts: unknown[]): UIMessage => ({ id, role: 'assistant', parts }) as unknown as UIMessage;

describe('applyToolApprovalResponse', () => {
  it('flips the matching paused part to approval-responded with the answer, leaving siblings and other messages by reference', () => {
    const other = msg('m0', [paused('x', 'ap-x')]);
    const target = msg('m1', [paused('a', 'ap-a'), { type: 'text', text: 'hi' }]);
    const out = applyToolApprovalResponse([other, target], { messageId: 'm1', toolCallId: 'a', approval: { id: 'ap-a', approved: false, reason: 'no' } });
    expect(out[0]).toBe(other);
    expect(out[1].parts[0]).toMatchObject({ state: 'approval-responded', approval: { id: 'ap-a', approved: false, reason: 'no' } });
    expect(out[1].parts[1]).toBe(target.parts[1]);
  });

  it('returns the input reference when the message or the tool call is not present, or the message has no parts', () => {
    const list = [msg('m1', [paused('a', 'ap-a')])];
    expect(applyToolApprovalResponse(list, { messageId: 'nope', toolCallId: 'a', approval: { id: 'ap-a', approved: true } })).toBe(list);
    expect(applyToolApprovalResponse(list, { messageId: 'm1', toolCallId: 'nope', approval: { id: 'ap-a', approved: true } })).toBe(list);
    const noParts = [{ id: 'm1', role: 'assistant' } as unknown as UIMessage];
    expect(applyToolApprovalResponse(noParts, { messageId: 'm1', toolCallId: 'a', approval: { id: 'ap-a', approved: true } })).toBe(noParts);
  });

  it.each(['approval-responded', 'output-available', 'output-error', 'output-denied'])(
    'never overwrites a part already in %s (a realtime event or a replay landing after the server moved on) — returns the input reference',
    (state) => {
      const list = [msg('m1', [{ ...paused('a', 'ap-a'), state, approval: { id: 'ap-a', approved: false } }])];
      expect(applyToolApprovalResponse(list, { messageId: 'm1', toolCallId: 'a', approval: { id: 'ap-a', approved: true } })).toBe(list);
    },
  );
});

describe('revertToolApprovalResponse', () => {
  it('returns the part to approval-requested and keeps only the approval id', () => {
    const answered = applyToolApprovalResponse([msg('m1', [paused('a', 'ap-a')])], { messageId: 'm1', toolCallId: 'a', approval: { id: 'ap-a', approved: true, reason: 'ok' } });
    const out = revertToolApprovalResponse(answered, { messageId: 'm1', toolCallId: 'a' });
    expect(out[0].parts[0]).toEqual({ type: 'tool-trash_page', toolCallId: 'a', state: 'approval-requested', input: { pageId: 'p' }, approval: { id: 'ap-a' } });
  });

  it('a part with no approval record reverts without inventing one', () => {
    const out = revertToolApprovalResponse([msg('m1', [{ type: 'tool-trash_page', toolCallId: 'a', state: 'approval-responded' }])], { messageId: 'm1', toolCallId: 'a' });
    expect(out[0].parts[0]).toEqual({ type: 'tool-trash_page', toolCallId: 'a', state: 'approval-requested' });
  });

  it.each(['approval-requested', 'output-available', 'output-error', 'output-denied'])(
    'leaves a part in %s alone (newer server truth arrived before the 409) — returns the input reference',
    (state) => {
      const list = [msg('m1', [{ ...paused('a', 'ap-a'), state, approval: { id: 'ap-a', approved: true } }])];
      expect(revertToolApprovalResponse(list, { messageId: 'm1', toolCallId: 'a' })).toBe(list);
    },
  );
});

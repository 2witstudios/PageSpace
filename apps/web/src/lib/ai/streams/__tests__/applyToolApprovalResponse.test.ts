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
    const out = revertToolApprovalResponse(answered, { messageId: 'm1', toolCallId: 'a', approval: { id: 'ap-a', approved: true, reason: 'ok' } });
    expect(out[0].parts[0]).toEqual({ type: 'tool-trash_page', toolCallId: 'a', state: 'approval-requested', input: { pageId: 'p' }, approval: { id: 'ap-a' } });
  });

  it('given the part carries a DIFFERENT answer than the one this tab applied (another tab answered first), leaves it alone', () => {
    const list = [msg('m1', [{ ...paused('a', 'ap-a'), state: 'approval-responded', approval: { id: 'ap-a', approved: false, reason: 'no' } }])];
    expect(revertToolApprovalResponse(list, { messageId: 'm1', toolCallId: 'a', approval: { id: 'ap-a', approved: true } })).toBe(list);
  });

  it('given the part carries a different approval id (a re-issued request), leaves it alone', () => {
    const list = [msg('m1', [{ ...paused('a', 'ap-b'), state: 'approval-responded', approval: { id: 'ap-b', approved: true } }])];
    expect(revertToolApprovalResponse(list, { messageId: 'm1', toolCallId: 'a', approval: { id: 'ap-a', approved: true } })).toBe(list);
  });

  /**
   * Known limit: another tab's answer that is IDENTICAL to ours (same id, same
   * approved, same reason) cannot be told apart from our own optimistic flip by
   * value, so it is reverted. That only reopens the card until the realtime
   * update for the executed call (output-*) lands, and a click in the meantime
   * is refused by the server with a 409 again — no answer is lost or doubled.
   */
  it('given an identical answer, reverts (indistinguishable from our own flip — see the note above)', () => {
    const answered = applyToolApprovalResponse([msg('m1', [paused('a', 'ap-a')])], { messageId: 'm1', toolCallId: 'a', approval: { id: 'ap-a', approved: true } });
    const out = revertToolApprovalResponse(answered, { messageId: 'm1', toolCallId: 'a', approval: { id: 'ap-a', approved: true } });
    expect(out[0].parts[0]).toMatchObject({ state: 'approval-requested', approval: { id: 'ap-a' } });
  });

  it.each(['approval-requested', 'output-available', 'output-error', 'output-denied'])(
    'leaves a part in %s alone (newer server truth arrived before the 409) — returns the input reference',
    (state) => {
      const list = [msg('m1', [{ ...paused('a', 'ap-a'), state, approval: { id: 'ap-a', approved: true } }])];
      expect(revertToolApprovalResponse(list, { messageId: 'm1', toolCallId: 'a', approval: { id: 'ap-a', approved: true } })).toBe(list);
    },
  );
});

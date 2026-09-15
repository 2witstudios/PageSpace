import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRespondToApproval, type UseRespondToApprovalOptions } from '../useRespondToApproval';
import { useAskUserAnsweringStore } from '@/stores/useAskUserAnsweringStore';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import type { RenderedMessage } from '@/lib/ai/streams/selectRenderedMessages';
import type { UIMessage } from 'ai';

const pausedMessage = (messageId: string, toolCallIds: string[]): RenderedMessage => ({
  mode: 'confirmed',
  message: {
    id: messageId,
    role: 'assistant',
    parts: toolCallIds.map((toolCallId) => ({
      type: 'tool-trash_page', toolCallId, state: 'approval-requested', input: {}, approval: { id: `ap-${toolCallId}` },
    })),
  } as unknown as UIMessage,
});

const baseOptions = (overrides: Partial<UseRespondToApprovalOptions> = {}): UseRespondToApprovalOptions => ({
  conversationId: 'conv-1',
  renderedMessages: [pausedMessage('m1', ['tc1'])],
  isConversationBusy: false,
  addToolApprovalResponse: vi.fn().mockResolvedValue({ dispatched: true }),
  wrapSend: (sendFn) => sendFn(),
  releasePendingSend: vi.fn(),
  buildBody: () => ({ chatId: 'p1' }),
  ...overrides,
});

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('useRespondToApproval', () => {
  beforeEach(() => {
    useAskUserAnsweringStore.setState({ answeringToolCallIds: new Set() });
    useConversationMessagesStore.setState({ byConversationId: {} });
    vi.restoreAllMocks();
  });

  it('exposes the paused calls on the last message as approvable', () => {
    const { result } = renderHook(() => useRespondToApproval(baseOptions({ renderedMessages: [pausedMessage('m1', ['tc1', 'tc2'])] })));
    expect(result.current.approvableToolCallIds).toEqual(new Set(['tc1', 'tc2']));
  });

  it('given an approvable respond, should claim, patch optimistically with the decision, send with the scope, then clear the claim', async () => {
    const applySpy = vi.spyOn(conversationMessagesActions, 'applyToolApprovalResponse');
    const addToolApprovalResponse = vi.fn().mockResolvedValue({ dispatched: true });
    const { result } = renderHook(() => useRespondToApproval(baseOptions({ addToolApprovalResponse })));

    await act(async () => {
      result.current.respond('tc1', { approvalId: 'ap-tc1', approved: true, scope: 'conversation' });
      await flush();
    });

    expect(applySpy).toHaveBeenCalledWith('conv-1', { messageId: 'm1', toolCallId: 'tc1', approval: { id: 'ap-tc1', approved: true } });
    expect(addToolApprovalResponse).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'tc1', approvalId: 'ap-tc1', approved: true, scope: 'conversation', conversationId: 'conv-1', options: { body: { chatId: 'p1' } } }),
    );
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc1')).toBe(false);
  });

  it('a denial carries the reason and never a scope', async () => {
    const addToolApprovalResponse = vi.fn().mockResolvedValue({ dispatched: true });
    const { result } = renderHook(() => useRespondToApproval(baseOptions({ addToolApprovalResponse })));
    await act(async () => {
      result.current.respond('tc1', { approvalId: 'ap-tc1', approved: false, reason: 'not that page', scope: 'always' });
      await flush();
    });
    expect(addToolApprovalResponse).toHaveBeenCalledWith(expect.objectContaining({ approved: false, reason: 'not that page', scope: undefined }));
  });

  it('given the send rejects (409 already resolved, or network), should revert the optimistic patch and clear the claim', async () => {
    const revertSpy = vi.spyOn(conversationMessagesActions, 'revertToolApprovalResponse');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const addToolApprovalResponse = vi.fn().mockRejectedValue(new Error('approval_already_resolved'));
    const { result } = renderHook(() => useRespondToApproval(baseOptions({ addToolApprovalResponse })));
    await act(async () => {
      result.current.respond('tc1', { approvalId: 'ap-tc1', approved: true });
      await flush();
    });
    expect(revertSpy).toHaveBeenCalledWith('conv-1', { messageId: 'm1', toolCallId: 'tc1' });
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc1')).toBe(false);
  });

  it('given the toolCallId is not approvable, should not call wrapSend at all', () => {
    const wrapSend = vi.fn();
    const { result } = renderHook(() => useRespondToApproval(baseOptions({ wrapSend, isConversationBusy: true })));
    act(() => {
      result.current.respond('tc1', { approvalId: 'ap-tc1', approved: true });
    });
    expect(wrapSend).not.toHaveBeenCalled();
  });

  it('given wrapSend never invokes its callback, should not leak the claim or the patch', async () => {
    const applySpy = vi.spyOn(conversationMessagesActions, 'applyToolApprovalResponse');
    const wrapSend = vi.fn().mockReturnValue(undefined);
    const { result } = renderHook(() => useRespondToApproval(baseOptions({ wrapSend })));
    act(() => {
      result.current.respond('tc1', { approvalId: 'ap-tc1', approved: true });
    });
    await flush();
    expect(wrapSend).toHaveBeenCalledTimes(1);
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc1')).toBe(false);
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('given the answer did not resume the turn (another approval still pending), releases the pendingSend; given it did, does not', async () => {
    const releasePendingSend = vi.fn();
    const addToolApprovalResponse = vi.fn().mockResolvedValueOnce({ dispatched: false }).mockResolvedValueOnce({ dispatched: true });
    const { result } = renderHook(() =>
      useRespondToApproval(baseOptions({ addToolApprovalResponse, releasePendingSend, renderedMessages: [pausedMessage('m1', ['tc1', 'tc2'])] })),
    );
    await act(async () => {
      result.current.respond('tc1', { approvalId: 'ap-tc1', approved: true });
      await flush();
    });
    expect(releasePendingSend).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.current.respond('tc2', { approvalId: 'ap-tc2', approved: true });
      await flush();
    });
    expect(releasePendingSend).toHaveBeenCalledTimes(1);
  });

  it('given the claim race is lost (another surface got there first), releases without sending', async () => {
    const releasePendingSend = vi.fn();
    const addToolApprovalResponse = vi.fn();
    useAskUserAnsweringStore.setState({ answeringToolCallIds: new Set() });
    const { result } = renderHook(() => useRespondToApproval(baseOptions({ addToolApprovalResponse, releasePendingSend })));
    // Simulate the other surface claiming between render and submit.
    useAskUserAnsweringStore.getState().claimAnswering('tc1');
    await act(async () => {
      result.current.respond('tc1', { approvalId: 'ap-tc1', approved: true });
      await flush();
    });
    expect(addToolApprovalResponse).not.toHaveBeenCalled();
    expect(releasePendingSend).toHaveBeenCalledTimes(1);
  });
});

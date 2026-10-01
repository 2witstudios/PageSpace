import { describe, it, expect, vi, beforeEach } from 'vitest';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));

import { renderHook, act } from '@testing-library/react';
import { useRespondToApproval, type UseRespondToApprovalOptions } from '../useRespondToApproval';
import { useAskUserAnsweringStore } from '@/stores/useAskUserAnsweringStore';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import type { RenderedMessage } from '@/lib/ai/streams/selectRenderedMessages';
import type { UIMessage } from 'ai';
import { toErrorCause } from '@/lib/ai/shared/toErrorCause';

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
    toastError.mockClear();
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
    expect(revertSpy).toHaveBeenCalledWith('conv-1', { messageId: 'm1', toolCallId: 'tc1', approval: { id: 'ap-tc1', approved: true } });
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

  it('given the send rejects, releases the pendingSend and shows the error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const releasePendingSend = vi.fn();
    const addToolApprovalResponse = vi.fn().mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useRespondToApproval(baseOptions({ addToolApprovalResponse, releasePendingSend })));
    await act(async () => {
      result.current.respond('tc1', { approvalId: 'ap-tc1', approved: true });
      await flush();
    });
    expect(releasePendingSend).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('given buildBody throws, reverts, releases the pendingSend, clears the claim, and shows the error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const revertSpy = vi.spyOn(conversationMessagesActions, 'revertToolApprovalResponse');
    const releasePendingSend = vi.fn();
    const addToolApprovalResponse = vi.fn();
    const buildBody = () => {
      throw new Error('no provider');
    };
    const { result } = renderHook(() => useRespondToApproval(baseOptions({ addToolApprovalResponse, releasePendingSend, buildBody })));
    await act(async () => {
      result.current.respond('tc1', { approvalId: 'ap-tc1', approved: true });
      await flush();
    });
    expect(addToolApprovalResponse).not.toHaveBeenCalled();
    expect(revertSpy).toHaveBeenCalledTimes(1);
    expect(releasePendingSend).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc1')).toBe(false);
  });

  it("given a 409, shows the server's message rather than a generic error", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const cause = toErrorCause(409, { error: 'This approval was already answered.', code: 'approval_already_resolved' });
    const addToolApprovalResponse = vi.fn().mockRejectedValue(new Error(cause.message, { cause }));
    const { result } = renderHook(() => useRespondToApproval(baseOptions({ addToolApprovalResponse })));
    await act(async () => {
      result.current.respond('tc1', { approvalId: 'ap-tc1', approved: true });
      await flush();
    });
    expect(toastError).toHaveBeenCalledWith('This approval was already answered.');
  });

  describe('awaitingToolCallIds', () => {
    const withParts = (parts: Array<{ toolCallId: string; state: string; approved?: boolean }>): RenderedMessage => ({
      mode: 'confirmed',
      message: {
        id: 'm1',
        role: 'assistant',
        parts: parts.map(({ toolCallId, state, approved }) => ({
          type: 'tool-trash_page',
          toolCallId,
          state,
          input: {},
          approval: approved === undefined ? { id: `ap-${toolCallId}` } : { id: `ap-${toolCallId}`, approved },
        })),
      } as unknown as UIMessage,
    });

    it('lists an approved call on the last message while a sibling still waits for an answer (nothing has run yet)', () => {
      const renderedMessages = [withParts([
        { toolCallId: 'tc1', state: 'approval-responded', approved: true },
        { toolCallId: 'tc2', state: 'approval-requested' },
      ])];
      const { result } = renderHook(() => useRespondToApproval(baseOptions({ renderedMessages })));
      expect(result.current.awaitingToolCallIds).toEqual(new Set(['tc1']));
    });

    it('is empty once every call on the turn is answered (the turn resumes)', () => {
      const renderedMessages = [withParts([
        { toolCallId: 'tc1', state: 'approval-responded', approved: true },
        { toolCallId: 'tc2', state: 'approval-responded', approved: false },
      ])];
      const { result } = renderHook(() => useRespondToApproval(baseOptions({ renderedMessages })));
      expect(result.current.awaitingToolCallIds).toEqual(new Set());
    });

    it('never lists an approved call on an older message', () => {
      const older = withParts([{ toolCallId: 'tc1', state: 'approval-responded', approved: true }]);
      const renderedMessages = [{ ...older, message: { ...older.message, id: 'm0' } }, pausedMessage('m1', ['tc9'])];
      const { result } = renderHook(() => useRespondToApproval(baseOptions({ renderedMessages })));
      expect(result.current.awaitingToolCallIds).toEqual(new Set());
    });
  });
});

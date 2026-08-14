import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAnswerAskUser, type UseAnswerAskUserOptions } from '../useAnswerAskUser';
import { useAskUserAnsweringStore } from '@/stores/useAskUserAnsweringStore';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import type { RenderedMessage } from '@/lib/ai/streams/selectRenderedMessages';
import type { UIMessage } from 'ai';

const askUserMessage = (messageId: string, toolCallId: string): RenderedMessage => ({
  mode: 'confirmed',
  message: {
    id: messageId,
    role: 'assistant',
    parts: [
      { type: 'tool-ask_user', toolCallId, state: 'input-available', input: {}, output: undefined },
    ],
  } as UIMessage,
});

const baseOptions = (overrides: Partial<UseAnswerAskUserOptions> = {}): UseAnswerAskUserOptions => ({
  conversationId: 'conv-1',
  renderedMessages: [askUserMessage('m1', 'tc1')],
  isConversationBusy: false,
  addToolResult: vi.fn().mockResolvedValue(undefined),
  wrapSend: (sendFn) => sendFn(),
  buildBody: () => ({}),
  ...overrides,
});

describe('useAnswerAskUser', () => {
  beforeEach(() => {
    useAskUserAnsweringStore.setState({ answeringToolCallIds: new Set() });
    useConversationMessagesStore.setState({ byConversationId: {} });
  });

  it('given wrapSend never invokes its callback (request dropped), should not leak the claimAnswering mutex', async () => {
    const applyAskUserAnswerSpy = vi.spyOn(conversationMessagesActions, 'applyAskUserAnswer');
    const wrapSend = vi.fn().mockReturnValue(undefined); // never calls sendFn — mirrors useSendHandoff's !conversationId early-return
    const { result } = renderHook(() => useAnswerAskUser(baseOptions({ wrapSend })));

    act(() => {
      result.current.submitAnswers('tc1', { answers: [{ header: 'h', question: 'q', otherText: 'hi' }] });
    });
    await Promise.resolve();

    expect(wrapSend).toHaveBeenCalledTimes(1);
    // Neither the mutex nor the optimistic patch should have been applied — the callback
    // wrapSend was supposed to invoke never ran (PR 6 review, CodeRabbit, Critical).
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc1')).toBe(false);
    expect(applyAskUserAnswerSpy).not.toHaveBeenCalled();
  });

  it('given a normal answerable submit, should claim, patch optimistically, hydrate+send, then clear the claim', async () => {
    const addToolResult = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useAnswerAskUser(baseOptions({ addToolResult })),
    );

    await act(async () => {
      result.current.submitAnswers('tc1', { answers: [{ header: 'h', question: 'q', otherText: 'hi' }] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addToolResult).toHaveBeenCalledTimes(1);
    // Claim is released once the send settles.
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc1')).toBe(false);
  });

  it('given addToolResult rejects, should revert the optimistic patch and still clear the claim', async () => {
    const revertSpy = vi.spyOn(conversationMessagesActions, 'revertAskUserAnswer');
    const addToolResult = vi.fn().mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() =>
      useAnswerAskUser(baseOptions({ addToolResult })),
    );

    await act(async () => {
      result.current.submitAnswers('tc1', { answers: [{ header: 'h', question: 'q', otherText: 'hi' }] });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(revertSpy).toHaveBeenCalledWith('conv-1', { messageId: 'm1', toolCallId: 'tc1' });
    expect(useAskUserAnsweringStore.getState().answeringToolCallIds.has('tc1')).toBe(false);
  });

  it('given the toolCallId is not currently answerable, should not call wrapSend at all', () => {
    const wrapSend = vi.fn();
    const { result } = renderHook(() =>
      useAnswerAskUser(baseOptions({ wrapSend, isConversationBusy: true })),
    );

    act(() => {
      result.current.submitAnswers('tc1', { answers: [{ header: 'h', question: 'q', otherText: 'hi' }] });
    });

    expect(wrapSend).not.toHaveBeenCalled();
  });

  // Answering re-invokes the chat (addToolResult auto-resend) — with a shared chat instance it
  // must go through the cross-conversation handoff like every other send path (dual-stream fix).
  // TWO HANDOFF CASES WERE HERE ('given a refused handoff…', 'given a confirmed handoff…').
  //
  // They pinned `useConversationSendHandoff`, which existed because the AI SDK's `Chat` could
  // not consume two response bodies at once: answering a question re-invokes the chat, and with
  // one shared instance per surface the question's conversation could be ON SCREEN while the
  // chat was still consuming ANOTHER conversation's stream. A refusal meant the user's click
  // did nothing but raise a toast.
  //
  // `useChatSession` has no shared instance and no single-body limit — a resume is simply a
  // `fetch` alongside whatever else is in flight — so the handoff is deleted rather than
  // moved, and there is no refusal path left to have behaviour. The cases go with it.
});

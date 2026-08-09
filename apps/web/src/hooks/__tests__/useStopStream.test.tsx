import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const { mockAbortByMessageId, mockAbortByConversation, mockReportAbortOutcome } = vi.hoisted(() => ({
  mockAbortByMessageId: vi.fn(async () => ({ aborted: true, code: 'aborted', reason: '' })),
  mockAbortByConversation: vi.fn(async () => ({ aborted: true, code: 'aborted', reason: '' })),
  mockReportAbortOutcome: vi.fn(),
}));

vi.mock('@/lib/ai/core/client', () => ({
  abortActiveStreamByMessageId: mockAbortByMessageId,
  abortActiveStreamByConversation: mockAbortByConversation,
  reportAbortOutcome: mockReportAbortOutcome,
}));

import { useStopStream } from '../useStopStream';
import type { ActiveStream } from '@/lib/ai/streams/selectActiveStream';

const OWN_STREAM: ActiveStream = {
  messageId: 'msg-1',
  conversationId: 'conv-1',
  isOwn: true,
};

describe('useStopStream — rawStop conversation gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const run = ({
    latched,
    target,
    activeStream,
  }: {
    latched: string | undefined;
    target: string | null;
    activeStream?: ActiveStream;
  }) => {
    const rawStop = vi.fn();
    const { result } = renderHook(() =>
      useStopStream({
        activeStream,
        pendingSendConversationId: null,
        rawStop,
        getLocalSendConversationId: () => latched,
        targetConversationId: target,
      }),
    );
    return { stop: result.current, rawStop };
  };

  it('given an idle chat (no latch), should call rawStop (harmless no-op, never suppressed)', async () => {
    const { stop, rawStop } = run({ latched: undefined, target: 'conv-1', activeStream: OWN_STREAM });

    await act(async () => { await stop(); });

    expect(rawStop).toHaveBeenCalledTimes(1);
  });

  it('given the local fetch belongs to the conversation being stopped, should call rawStop', async () => {
    const { stop, rawStop } = run({ latched: 'conv-1', target: 'conv-1', activeStream: OWN_STREAM });

    await act(async () => { await stop(); });

    expect(rawStop).toHaveBeenCalledTimes(1);
  });

  // THE gate. Conversation A renders via the socket (handed off) while this chat's local fetch
  // consumes conversation B. Stop pressed on A must abort A on the SERVER but must not cancel
  // B's live local read — that would send B dark mid-token.
  it('given the local fetch belongs to ANOTHER conversation, should skip rawStop but still abort on the server', async () => {
    const { stop, rawStop } = run({ latched: 'conv-2', target: 'conv-1', activeStream: OWN_STREAM });

    await act(async () => { await stop(); });

    expect(rawStop).not.toHaveBeenCalled();
    expect(mockAbortByMessageId).toHaveBeenCalledWith({ messageId: 'msg-1' });
  });

  it('given an empty-string latch (unresolved-identity placeholder), should call rawStop', async () => {
    const { stop, rawStop } = run({ latched: '', target: 'conv-1', activeStream: OWN_STREAM });

    await act(async () => { await stop(); });

    expect(rawStop).toHaveBeenCalledTimes(1);
  });

  it('given no target conversation (null), should call rawStop (no basis to withhold it)', async () => {
    const { stop, rawStop } = run({ latched: 'conv-2', target: null });

    await act(async () => { await stop(); });

    expect(rawStop).toHaveBeenCalledTimes(1);
  });

  it('given nothing live and nothing sent, should stay silent (no server abort, no report)', async () => {
    const { stop } = run({ latched: undefined, target: 'conv-1' });

    await act(async () => { await stop(); });

    expect(mockAbortByMessageId).not.toHaveBeenCalled();
    expect(mockAbortByConversation).not.toHaveBeenCalled();
    expect(mockReportAbortOutcome).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStopStream } from '../useStopStream';
import type { ActiveStream } from '@/lib/ai/streams/selectActiveStream';

const abortByMessageId = vi.fn();
const abortByConversation = vi.fn();
const reportAbortOutcome = vi.fn();

vi.mock('@/lib/ai/core/client', () => ({
  abortActiveStreamByMessageId: (args: { messageId: string }) => abortByMessageId(args),
  abortActiveStreamByConversation: (args: { conversationId: string }) => abortByConversation(args),
  reportAbortOutcome: (result: unknown) => reportAbortOutcome(result),
}));

const OK = { aborted: true, code: 'aborted' as const, reason: 'stopped' };

/**
 * Stop is a SERVER action, and these cases are all about which name it sends.
 *
 * The local-stop half of this hook is gone — see `useStopStream`'s docblock and
 * `only-a-deliberate-stop.test.ts`. Two cases that used to live here ("given an idle chat, calls
 * rawStop"; "given no target conversation, calls rawStop") pinned a mechanism that no longer
 * exists and are deleted rather than rewritten: cancelling a local read never stopped a
 * generation, so there is no behaviour under them to preserve. What they were really protecting
 * — that a Stop always names something true server-side — is the subject of every case below.
 */
describe('useStopStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    abortByMessageId.mockResolvedValue(OK);
    abortByConversation.mockResolvedValue(OK);
  });

  const liveStream = (messageId: string): ActiveStream =>
    ({ messageId, conversationId: 'conv-1', isOwn: true }) as ActiveStream;

  it('given a live own stream, aborts by its messageId and reports the outcome', async () => {
    const { result } = renderHook(() =>
      useStopStream({ activeStream: liveStream('msg-1'), pendingSendConversationId: null }),
    );

    await act(async () => {
      await result.current();
    });

    expect(abortByMessageId).toHaveBeenCalledWith({ messageId: 'msg-1' });
    expect(abortByConversation).not.toHaveBeenCalled();
    expect(reportAbortOutcome).toHaveBeenCalledWith(OK);
  });

  it('given only a pending send, aborts by the conversation captured at send', async () => {
    // The TTFB window: the server has not issued a messageId yet, so the conversation is the
    // only name the client holds — and this is exactly when a user who spotted a typo presses
    // Stop. Without this branch the abort would silently name nothing.
    const { result } = renderHook(() =>
      useStopStream({ activeStream: undefined, pendingSendConversationId: 'conv-9' }),
    );

    await act(async () => {
      await result.current();
    });

    expect(abortByConversation).toHaveBeenCalledWith({ conversationId: 'conv-9' });
    expect(abortByMessageId).not.toHaveBeenCalled();
    expect(reportAbortOutcome).toHaveBeenCalledWith(OK);
  });

  it('given nothing live and nothing sent, issues no abort and stays silent', async () => {
    const { result } = renderHook(() =>
      useStopStream({ activeStream: undefined, pendingSendConversationId: null }),
    );

    await act(async () => {
      await result.current();
    });

    expect(abortByMessageId).not.toHaveBeenCalled();
    expect(abortByConversation).not.toHaveBeenCalled();
    // Deliberately silent: there is nothing to report and nothing to name.
    expect(reportAbortOutcome).not.toHaveBeenCalled();
  });

  it('given an unconfirmed abort, still reports it so the user learns the stream may run on', async () => {
    const unconfirmed = { aborted: false, code: 'unconfirmed' as const, reason: 'no response' };
    abortByMessageId.mockResolvedValue(unconfirmed);

    const { result } = renderHook(() =>
      useStopStream({ activeStream: liveStream('msg-2'), pendingSendConversationId: null }),
    );

    await act(async () => {
      await result.current();
    });

    expect(reportAbortOutcome).toHaveBeenCalledWith(unconfirmed);
  });
});

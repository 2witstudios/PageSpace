import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useStopStream, STOPPING_FEEDBACK_TIMEOUT_MS } from '../useStopStream';
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
      await result.current.handleStop();
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
      await result.current.handleStop();
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
      await result.current.handleStop();
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
      await result.current.handleStop();
    });

    expect(reportAbortOutcome).toHaveBeenCalledWith(unconfirmed);
  });
});

// ---------------------------------------------------------------------------------------------
// `isStopping` — the feedback that replaces the deleted local stop, without its lie.
//
// Deleting `rawStop` was right (see the hook's docblock and only-a-deliberate-stop.test.ts), but
// it left the click with nothing to show for itself: reportAbortOutcome is silent on every
// outcome but 'unconfirmed', so the abort POST's resolved value paints zero pixels, and what
// actually clears the bubble and flips the composer is the chat:stream_complete SOCKET event.
// The screen sat unchanged for a full round trip — up to ABORT_SETTLE_TIMEOUT_MS of deliberate
// server-side settle on a cross-instance owner — plus socket delivery.
// ---------------------------------------------------------------------------------------------
describe('useStopStream — isStopping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    abortByMessageId.mockResolvedValue(OK);
    abortByConversation.mockResolvedValue(OK);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const OWN_STREAM = { messageId: 'msg-1', conversationId: 'conv-1', isOwn: true } as ActiveStream;

  const renderStop = (props: {
    activeStream?: ActiveStream;
    pendingSendConversationId?: string | null;
  }) =>
    renderHook(
      (p: { activeStream?: ActiveStream; pendingSendConversationId: string | null }) =>
        useStopStream({
          activeStream: p.activeStream,
          pendingSendConversationId: p.pendingSendConversationId,
        }),
      {
        initialProps: {
          activeStream: props.activeStream,
          pendingSendConversationId: props.pendingSendConversationId ?? null,
        },
      },
    );

  it('given Stop is pressed, should set isStopping BEFORE the abort resolves, not after', async () => {
    // Never resolves: if the flag were set after the await, nothing would ever paint.
    let release: (() => void) | undefined;
    abortByMessageId.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve(OK); }),
    );

    const { result } = renderStop({ activeStream: OWN_STREAM });
    expect(result.current.isStopping).toBe(false);

    act(() => { void result.current.handleStop(); });

    expect(result.current.isStopping).toBe(true);
    expect(abortByMessageId).toHaveBeenCalledTimes(1);

    await act(async () => { release?.(); });
  });

  // The reply keeps rendering underneath. This hook must not treat its own flag as teardown —
  // chat:stream_complete is the sole authority, and the stream is still here until it says so.
  it('given the abort has resolved but the stream entry is still live, should stay stopping (never "stopped")', async () => {
    const { result } = renderStop({ activeStream: OWN_STREAM });

    await act(async () => { await result.current.handleStop(); });

    expect(result.current.isStopping).toBe(true);
  });

  // THE clear: chat:stream_complete removes the store entry, so `activeStream` goes away.
  it('given the socket landing removes the live stream, should clear isStopping', async () => {
    const { result, rerender } = renderStop({ activeStream: OWN_STREAM });

    await act(async () => { await result.current.handleStop(); });
    expect(result.current.isStopping).toBe(true);

    rerender({ activeStream: undefined, pendingSendConversationId: null });

    expect(result.current.isStopping).toBe(false);
  });

  // Stop pressed in the TTFB window names the pendingSend conversation; that name resolving is
  // the same landing.
  it('given a Stop in the TTFB window, should clear isStopping when the pendingSend resolves', async () => {
    const { result, rerender } = renderStop({ pendingSendConversationId: 'conv-1' });

    await act(async () => { await result.current.handleStop(); });
    expect(result.current.isStopping).toBe(true);
    expect(abortByConversation).toHaveBeenCalledWith({ conversationId: 'conv-1' });

    rerender({ activeStream: undefined, pendingSendConversationId: null });

    expect(result.current.isStopping).toBe(false);
  });

  // A socket that never arrives (dropped connection, dead owning instance) must not wedge the
  // button spinning until unmount.
  it('given no socket ever lands, should release isStopping on the bounded timeout', async () => {
    vi.useFakeTimers();
    const { result } = renderStop({ activeStream: OWN_STREAM });

    await act(async () => { await result.current.handleStop(); });
    expect(result.current.isStopping).toBe(true);

    // Still stopping just short of the horizon — the wait has to outlast an honest slow abort.
    act(() => { vi.advanceTimersByTime(STOPPING_FEEDBACK_TIMEOUT_MS - 1); });
    expect(result.current.isStopping).toBe(true);

    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.isStopping).toBe(false);
  });

  // 'not_found' is deliberately silent (a benign race, and a toast would train users to ignore
  // the real one), so a Stop pressed a beat after the reply finished produced NO feedback at
  // all. The affordance appearing and then releasing IS the acknowledgement — and it must
  // RELEASE, not hold: the server has just said nothing is running, so there is nothing to be
  // stopping, and holding would disable the button for the whole backstop over a no-op.
  it('given the server reports not_found, should acknowledge the click and then release', async () => {
    abortByMessageId.mockResolvedValue({ aborted: false, code: 'not_found', reason: 'no stream' });
    const { result } = renderStop({ activeStream: OWN_STREAM });

    act(() => { void result.current.handleStop(); });
    expect(result.current.isStopping).toBe(true);

    await waitFor(() => expect(result.current.isStopping).toBe(false));
    expect(reportAbortOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'not_found' }),
    );
  });

  // The helpers never throw on network failure — they resolve 'unconfirmed' (NETWORK_FAILURE),
  // which made the catch path unreachable for the case that most needs releasing: the user has
  // just been told the generation may still be running and billing, and the only control that
  // could stop it was disabled for the whole backstop.
  it('given an unconfirmed abort, should release so the user can immediately try again', async () => {
    abortByMessageId.mockResolvedValue({ aborted: false, code: 'unconfirmed', reason: 'no response' });
    const { result } = renderStop({ activeStream: OWN_STREAM });

    act(() => { void result.current.handleStop(); });
    expect(result.current.isStopping).toBe(true);

    await waitFor(() => expect(result.current.isStopping).toBe(false));
  });

  // THE P1. These surfaces keep ONE hook instance across a conversation switch. Stopping A and
  // then switching to B — which has its own stream running — must not disable B's Stop button
  // for a Stop nobody asked for.
  it('given a switch to another conversation with its own live stream, should not claim to be stopping it', async () => {
    const { result, rerender } = renderStop({ activeStream: OWN_STREAM });

    await act(async () => { await result.current.handleStop(); });
    expect(result.current.isStopping).toBe(true);

    // Same surface, same hook instance, different conversation — and B is streaming, so the
    // boolean "is anything stoppable?" this replaced stayed true here.
    rerender({
      activeStream: { messageId: 'msg-b', conversationId: 'conv-2', isOwn: true } as ActiveStream,
      pendingSendConversationId: null,
    });

    expect(result.current.isStopping).toBe(false);
  });

  // Nothing live and nothing sent: the composer is showing SEND, so this is unreachable by
  // click — but it must not be able to strand the affordance either.
  it('given nothing to stop at all, should not leave the affordance raised', async () => {
    const { result } = renderStop({ activeStream: undefined, pendingSendConversationId: null });

    await act(async () => { await result.current.handleStop(); });

    await waitFor(() => expect(result.current.isStopping).toBe(false));
  });

  it('given the abort throws, should clear isStopping rather than wait out the backstop', async () => {
    abortByMessageId.mockRejectedValue(new Error('boom'));
    const { result } = renderStop({ activeStream: OWN_STREAM });

    await act(async () => {
      await expect(result.current.handleStop()).rejects.toThrow('boom');
    });

    expect(result.current.isStopping).toBe(false);
  });

  // Found while re-reading the P1 fix, same failure family: every release runs AFTER an await,
  // so by then the user may have switched conversation and pressed Stop again. An unscoped
  // clearStopping() there wipes the SECOND Stop's feedback on the FIRST one's late reply.
  it('given a late reply from a superseded Stop, should not wipe the current conversation\'s stopping state', async () => {
    let releaseA: (() => void) | undefined;
    abortByMessageId.mockImplementationOnce(
      () => new Promise((resolve) => {
        // A's abort comes back 'unconfirmed' — the outcome that releases — but LATE.
        releaseA = () => resolve({ aborted: false, code: 'unconfirmed', reason: 'no response' });
      }),
    );

    const { result, rerender } = renderStop({ activeStream: OWN_STREAM });

    act(() => { void result.current.handleStop(); });
    expect(result.current.isStopping).toBe(true);

    // Switch to B and stop it too. B's abort resolves normally ('aborted' → hold).
    const streamB = { messageId: 'msg-b', conversationId: 'conv-2', isOwn: true } as ActiveStream;
    rerender({ activeStream: streamB, pendingSendConversationId: null });
    await act(async () => { await result.current.handleStop(); });
    expect(result.current.isStopping).toBe(true);

    // A's abort finally answers. It must not touch B's affordance.
    await act(async () => { releaseA?.(); await Promise.resolve(); await Promise.resolve(); });

    // Asserted after the queue has drained rather than via waitFor: this is a "stays true"
    // claim, and waitFor would pass on the first tick without ever proving it survived.
    expect(result.current.isStopping).toBe(true);
  });
});

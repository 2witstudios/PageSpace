import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { useQueuedSends } from '../useQueuedSends';
import { completeStreamSession, openStreamSession, resetStreamSessionRegistry } from '@/lib/ai/streams/streamSessionRegistry';
import { usePendingStreamsStore } from '@/stores/usePendingStreamsStore';
import { useConversationMessagesStore } from '@/stores/useConversationMessagesStore';
import { persistQueuedSends } from '@/stores/conversationMessages/queuedSendsPersistence';
import { recordStopRequest } from '@/lib/ai/streams/stopRequests';
import type { ChatSessionStatus } from '../useChatSession';

/**
 * The stream join is MOCKED so `openStreamSession` can run far enough to fire
 * the registry's end notification with `joinFailed: true` — the shape an
 * ERROR terminal takes (join errored / delivered nothing / server said
 * reload). `consumeStreamJoin` resolving with no `resumeFromSeq` and having
 * delivered nothing is exactly the "stream was already over" join.
 */
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));

vi.mock('@/lib/ai/core/stream-join-client', () => ({
  consumeStreamJoin: vi.fn(() => Promise.resolve({})),
  StreamJoinError: class StreamJoinError extends Error {
    status?: number;
  },
}));

const CONV = 'conv-1';

const flushMicrotasks = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

/** An end event for a session this tab never opened is still forwarded — the simplest honest trigger. */
const fireEnd = (messageId: string, conversationId: string, aborted?: boolean): void => {
  act(() => {
    completeStreamSession({ messageId, conversationId, channelId: 'chan-1', aborted });
  });
};

const addLiveStream = (messageId: string, conversationId: string, isOwn = true): void => {
  act(() => {
    usePendingStreamsStore.getState().addStream({
      messageId,
      pageId: 'chan-1',
      conversationId,
      triggeredBy: { userId: 'u1', displayName: 'You' },
      isOwn,
      startedAt: new Date().toISOString(),
      parts: [],
    });
  });
};

const clearLiveStreams = (): void => {
  usePendingStreamsStore.setState({ streams: new Map() });
};

const msgText = (message: UIMessage): string =>
  message.parts.filter((p) => p.type === 'text').map((p) => p.text).join('');

describe('useQueuedSends', () => {
  beforeEach(() => {
    toastError.mockClear();
    window.localStorage.clear();
    clearLiveStreams();
    useConversationMessagesStore.setState({ queuedSendsByConversationId: {} });
  });

  afterEach(() => {
    resetStreamSessionRegistry();
  });

  const mount = (options?: { status?: ChatSessionStatus; dispatch?: Mock }) => {
    const dispatch = options?.dispatch ?? vi.fn();
    let status = options?.status ?? 'ready';
    const hook = renderHook(
      ({ status: s }: { status: ChatSessionStatus }) =>
        useQueuedSends({ conversationId: CONV, status: s, dispatch }),
      { initialProps: { status: status as ChatSessionStatus } },
    );
    return {
      hook,
      dispatch,
      setStatus: (next: ChatSessionStatus) => {
        status = next;
        hook.rerender({ status: next });
      },
      enqueue: (text: string): boolean => {
        let ok = false;
        act(() => {
          ok = hook.result.current.enqueue(text);
        });
        return ok;
      },
    };
  };

  it('enqueues with a minted id in FIFO order and reports fullness', () => {
    const { hook } = mount();

    expect(hook.result.current.isQueueFull).toBe(false);
    act(() => { hook.result.current.enqueue('first'); });
    act(() => { hook.result.current.enqueue('second'); });

    expect(hook.result.current.queueCount).toBe(2);
    expect(hook.result.current.queuedSends.map(msgText)).toEqual(['first', 'second']);
    expect(hook.result.current.isQueueFull).toBe(false);
  });

  it('enqueue refuses empty text and returns false at the cap of 10 (queue full)', () => {
    const { hook, enqueue } = mount();

    expect(enqueue('   ')).toBe(false);
    for (let i = 0; i < 10; i++) {
      expect(enqueue(`q${i}`)).toBe(true);
    }
    expect(hook.result.current.isQueueFull).toBe(true);
    expect(enqueue('overflow')).toBe(false);
    expect(hook.result.current.queueCount).toBe(10);
  });

  it('remove drops the named entry; clear empties the queue', () => {
    const { hook } = mount();

    act(() => { hook.result.current.enqueue('first'); });
    act(() => { hook.result.current.enqueue('second'); });
    act(() => { hook.result.current.remove(hook.result.current.queuedSends[0].id); });
    expect(hook.result.current.queuedSends.map(msgText)).toEqual(['second']);

    act(() => { hook.result.current.clear(); });
    expect(hook.result.current.queueCount).toBe(0);
  });

  it('restore on mount preserves the persisted ids (idempotent re-dispatch)', async () => {
    persistQueuedSends(CONV, [
      { id: 'persisted-1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { id: 'persisted-2', role: 'user', parts: [{ type: 'text', text: 'second' }] },
    ] as UIMessage[]);

    const { hook, dispatch } = mount();

    // The registry never replays an end that fired before this subscription,
    // so the restored queue drains AT MOUNT, oldest first, with the id it was
    // persisted with — the idempotency backbone (the server upserts by id).
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((dispatch.mock.calls[0][0] as UIMessage).id).toBe('persisted-1');
    expect(hook.result.current.queuedSends.map((m) => m.id)).toEqual(['persisted-2']);

    // And the drained turn's own terminal releases the claim and drains the
    // next entry, still with its persisted id.
    await new Promise((r) => setTimeout(r, 10));
    fireEnd('turn-2', CONV);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((dispatch.mock.calls[1][0] as UIMessage).id).toBe('persisted-2');
  });

  it('a restored queue dispatches at mount without any later end event', () => {
    persistQueuedSends(CONV, [
      { id: 'persisted-1', role: 'user', parts: [{ type: 'text', text: 'owed a drain' }] },
    ] as UIMessage[]);

    const { hook, dispatch } = mount();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(msgText(dispatch.mock.calls[0][0] as UIMessage)).toBe('owed a drain');
    expect(hook.result.current.queueCount).toBe(0);
  });

  it('mount reconciliation still waits behind a live stream', () => {
    persistQueuedSends(CONV, [
      { id: 'persisted-1', role: 'user', parts: [{ type: 'text', text: 'waiting' }] },
    ] as UIMessage[]);
    addLiveStream('still-live', CONV);

    const { dispatch } = mount();
    expect(dispatch).not.toHaveBeenCalled();

    // The live stream's own terminal is the trigger that drains it.
    fireEnd('still-live', CONV);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('mount reconciliation still waits out a manual send TTFB window', () => {
    persistQueuedSends(CONV, [
      { id: 'persisted-1', role: 'user', parts: [{ type: 'text', text: 'waiting' }] },
    ] as UIMessage[]);

    const { dispatch, setStatus } = mount({ status: 'submitted' });
    expect(dispatch).not.toHaveBeenCalled();

    setStatus('ready');
    fireEnd('turn-1', CONV);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('never dispatches while another stream is live — the queued dispatch waits', () => {
    const { hook, dispatch } = mount();
    addLiveStream('own-live', CONV);

    act(() => { hook.result.current.enqueue('queued while streaming'); });

    // An end event for a DIFFERENT session of the same conversation: the live
    // one is still streaming, so nothing may dispatch.
    fireEnd('other-session', CONV);
    expect(dispatch).not.toHaveBeenCalled();
    expect(hook.result.current.queueCount).toBe(1);

    // The live stream's own terminal: now the drain fires.
    fireEnd('own-live', CONV);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(msgText(dispatch.mock.calls[0][0] as UIMessage)).toBe('queued while streaming');
    expect(hook.result.current.queueCount).toBe(0);
  });

  it('never dispatches while a REMOTE stream is live either (takeover aborts their turn)', () => {
    const { hook, dispatch } = mount();
    addLiveStream('remote-live', CONV, false);

    fireEnd('some-ended-session', CONV);
    expect(dispatch).not.toHaveBeenCalled();
    expect(hook.result.current.queueCount).toBe(0); // nothing queued yet — trivially
  });

  it('drains after a COMPLETE terminal', () => {
    const { hook, dispatch } = mount();
    act(() => { hook.result.current.enqueue('after complete'); });

    fireEnd('turn-1', CONV);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(msgText(dispatch.mock.calls[0][0] as UIMessage)).toBe('after complete');
  });

  it('drains after an ABORTED terminal (ESC stop)', () => {
    const { hook, dispatch } = mount();
    act(() => { hook.result.current.enqueue('after abort'); });

    fireEnd('turn-1', CONV, true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(msgText(dispatch.mock.calls[0][0] as UIMessage)).toBe('after abort');
  });

  it('drains after an ERROR terminal (join failed / poll fallback)', async () => {
    const { hook, dispatch } = mount();
    act(() => { hook.result.current.enqueue('after error'); });

    // Opens a real registry session whose (mocked) join delivers nothing —
    // the error-terminal shape. The entry lives until the end notification.
    act(() => {
      openStreamSession({
        messageId: 'errant-stream',
        conversationId: CONV,
        channelId: 'chan-1',
        triggeredBy: { userId: 'u1', displayName: 'You' },
        isOwn: true,
        startedAt: new Date().toISOString(),
      });
    });
    await flushMicrotasks();

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(msgText(dispatch.mock.calls[0][0] as UIMessage)).toBe('after error');
  });

  it('drains FIFO, one per turn, across consecutive terminals', async () => {
    const { hook, dispatch } = mount();
    act(() => { hook.result.current.enqueue('first'); });
    act(() => { hook.result.current.enqueue('second'); });

    fireEnd('turn-1', CONV);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(msgText(dispatch.mock.calls[0][0] as UIMessage)).toBe('first');

    // The drained turn's own terminal releases the claim and drains the next.
    await new Promise((r) => setTimeout(r, 10));
    fireEnd('turn-2', CONV);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(msgText(dispatch.mock.calls[1][0] as UIMessage)).toBe('second');
  });

  it('a manual send takes precedence — the queue waits out the submitted (TTFB) window', () => {
    const { hook, dispatch, setStatus } = mount({ status: 'submitted' });
    act(() => { hook.result.current.enqueue('waiting its turn'); });

    fireEnd('turn-1', CONV);
    expect(dispatch).not.toHaveBeenCalled();
    expect(hook.result.current.queueCount).toBe(1);

    setStatus('ready');
    fireEnd('turn-2', CONV);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(msgText(dispatch.mock.calls[0][0] as UIMessage)).toBe('waiting its turn');
  });

  it('a recorded stop request does NOT block the intentional drain (stopRequests interplay)', () => {
    const { hook, dispatch } = mount();
    act(() => { hook.result.current.enqueue('deliberate, not a race'); });

    // The user pressed Stop (ESC): the epoch moved. A queued message is the
    // opposite of what that guard prevents — the drain must still dispatch.
    act(() => { recordStopRequest(CONV); });

    fireEnd('turn-1', CONV, true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('double-ESC cancelPendingDrain clears the queue AND cancels the pending drain, once', () => {
    const { hook, dispatch } = mount();
    act(() => { hook.result.current.enqueue('killed by double-esc'); });
    act(() => { hook.result.current.cancelPendingDrain(); });
    expect(hook.result.current.queueCount).toBe(0);

    // The abort's terminal event arrives: the suppression consumes it — no dispatch.
    fireEnd('turn-1', CONV, true);
    expect(dispatch).not.toHaveBeenCalled();

    // One-shot: a LATER queue (typed during a fresh stream) drains normally.
    addLiveStream('turn-2', CONV);
    act(() => { hook.result.current.enqueue('queued again'); });
    fireEnd('turn-2', CONV);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(msgText(dispatch.mock.calls[0][0] as UIMessage)).toBe('queued again');
  });

  it('co-mounted surfaces for one conversation drain exactly once per terminal', async () => {
    const dispatchA = vi.fn();
    const dispatchB = vi.fn();
    renderHook(() => useQueuedSends({ conversationId: CONV, status: 'ready', dispatch: dispatchA }));
    const b = renderHook(() => useQueuedSends({ conversationId: CONV, status: 'ready', dispatch: dispatchB }));

    act(() => { b.result.current.enqueue('only once'); });

    // One end event, two subscribed hooks — a second dispatch would take the
    // first turn over server-side and abort it.
    fireEnd('turn-1', CONV);
    const total = dispatchA.mock.calls.length + dispatchB.mock.calls.length;
    expect(total).toBe(1);

    // The next terminal (the drained turn's own end) is free to drain again.
    await new Promise((r) => setTimeout(r, 10));
    fireEnd('turn-2', CONV);
    expect(dispatchA.mock.calls.length + dispatchB.mock.calls.length).toBe(1);
  });

  it('a rejected drained dispatch keeps the prompt queued at the head, surfaces an error, and retries it next turn', async () => {
    const dispatch = vi.fn()
      .mockImplementationOnce(() => Promise.reject(new Error('402 credit gate')))
      .mockImplementation(() => undefined);
    const { hook } = mount({ dispatch });

    act(() => { hook.result.current.enqueue('first'); });
    act(() => { hook.result.current.enqueue('second'); });
    const firstId = hook.result.current.queuedSends[0].id;

    fireEnd('turn-1', CONV);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await flushMicrotasks(); // the rejection restores the entry and releases the claim

    // Never silently lost: back at the head, same id (idempotent re-dispatch), persisted.
    expect(hook.result.current.queuedSends.map(msgText)).toEqual(['first', 'second']);
    expect(hook.result.current.queuedSends[0].id).toBe(firstId);
    expect(JSON.parse(window.localStorage.getItem(`pagespace:queued-sends:${CONV}`) ?? '[]').map((m: UIMessage) => m.id)[0]).toBe(firstId);
    expect(toastError).toHaveBeenCalledTimes(1);

    // Not wedged: the next terminal drains again, and it is the SAME prompt.
    await new Promise((r) => setTimeout(r, 10));
    fireEnd('turn-2', CONV);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect((dispatch.mock.calls[1][0] as UIMessage).id).toBe(firstId);
    expect(hook.result.current.queuedSends.map(msgText)).toEqual(['second']);
  });

  it('a synchronously throwing drained dispatch keeps the prompt queued too', async () => {
    const dispatch = vi.fn()
      .mockImplementationOnce(() => { throw new Error('sendMessage threw'); })
      .mockImplementation(() => undefined);
    const { hook } = mount({ dispatch });
    act(() => { hook.result.current.enqueue('only'); });

    fireEnd('turn-1', CONV);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(hook.result.current.queuedSends.map(msgText)).toEqual(['only']);
    expect(toastError).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 10));
    fireEnd('turn-2', CONV);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(msgText(dispatch.mock.calls[1][0] as UIMessage)).toBe('only');
  });

  it('a rejection lands back on a queue the user filled meanwhile without dropping anything, across a reload', async () => {
    let rejectDispatch: (error: Error) => void = () => {};
    const dispatch = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectDispatch = reject; }))
      .mockImplementation(() => undefined);
    const { hook, enqueue } = mount({ dispatch });
    for (let i = 1; i <= 10; i++) enqueue(`m${i}`);

    fireEnd('turn-1', CONV); // m1 goes out; 9 left
    expect(enqueue('m11')).toBe(true); // the user tops the queue back up to the cap
    await act(async () => { rejectDispatch(new Error('network')); await Promise.resolve(); await Promise.resolve(); });

    const expected = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11'];
    expect(hook.result.current.queuedSends.map(msgText)).toEqual(expected);
    expect(hook.result.current.isQueueFull).toBe(true);

    // A reload restores every entry — the requeued one is not truncated away.
    hook.unmount();
    useConversationMessagesStore.setState({ queuedSendsByConversationId: {} });
    addLiveStream('turn-live', CONV); // keep the remount from draining so the restore is observable
    const remounted = mount({ dispatch: vi.fn() });
    expect(remounted.hook.result.current.queuedSends.map(msgText)).toEqual(expected);
  });

  it('ignores end events for other conversations', () => {
    const { hook, dispatch } = mount();
    act(() => { hook.result.current.enqueue('mine'); });

    fireEnd('turn-1', 'conv-OTHER');
    expect(dispatch).not.toHaveBeenCalled();
    expect(hook.result.current.queueCount).toBe(1);
  });

  it('no conversation: enqueue is refused and nothing restores', () => {
    const dispatch = vi.fn();
    const hook = renderHook(() =>
      useQueuedSends({ conversationId: null, status: 'ready', dispatch }),
    );
    expect(hook.result.current.enqueue('nowhere')).toBe(false);
    expect(hook.result.current.queueCount).toBe(0);
    expect(hook.result.current.isQueueFull).toBe(false);
  });
});

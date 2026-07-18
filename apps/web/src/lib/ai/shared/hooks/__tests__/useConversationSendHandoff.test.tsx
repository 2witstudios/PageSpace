import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConversationSendHandoff } from '../useConversationSendHandoff';

type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error';

type Props = {
  status: ChatStatus;
  latched: string | undefined;
};

const setup = (initial: Props) => {
  const stop = vi.fn();
  const rejoin = vi.fn();
  const latchedRef = { current: initial.latched };
  const hook = renderHook(
    (props: Props) =>
      useConversationSendHandoff({
        status: props.status,
        stop,
        getLatchedConversationId: () => latchedRef.current,
        rejoin,
      }),
    { initialProps: initial },
  );
  return { ...hook, stop, rejoin, latchedRef };
};

/** Settled/pending/value probe for a prepareSend promise, without awaiting it. */
const probe = (promise: Promise<boolean>) => {
  let settled = false;
  let value: boolean | undefined;
  void promise.then((v) => { settled = true; value = v; });
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { isSettled: () => settled, value: () => value, flush };
};

describe('useConversationSendHandoff', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('given an idle chat (no latch), should resolve true immediately without stop or rejoin', async () => {
    const { result, stop, rejoin } = setup({ status: 'ready', latched: undefined });

    let ok = false;
    await act(async () => {
      ok = await result.current.prepareSend('conv-2');
    });

    expect(ok).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(rejoin).not.toHaveBeenCalled();
  });

  it('given a send into the conversation already being consumed, should be a no-op resolving true', async () => {
    const { result, stop, rejoin } = setup({ status: 'streaming', latched: 'conv-1' });

    let ok = false;
    await act(async () => {
      ok = await result.current.prepareSend('conv-1');
    });

    expect(ok).toBe(true);
    expect(stop).not.toHaveBeenCalled();
    expect(rejoin).not.toHaveBeenCalled();
  });

  // THE handoff. Chat 1 is streaming on this Chat instance; the user sends in chat 2. The SDK
  // cannot consume two bodies at once, so the in-flight stream must be stopped locally (it keeps
  // generating server-side) and handed to the socket path — and the send must WAIT for the chat
  // to settle, so the mirror's falling edge releases its latch before the next rising edge.
  it('given a send into a DIFFERENT conversation while streaming, should stop, wait for settle, then rejoin and resolve true', async () => {
    const { result, rerender, stop, rejoin, latchedRef } = setup({ status: 'streaming', latched: 'conv-1' });

    let prepare!: Promise<boolean>;
    act(() => {
      prepare = result.current.prepareSend('conv-2');
    });
    const p = probe(prepare);

    expect(stop).toHaveBeenCalledTimes(1);
    await p.flush();
    // Still streaming — the send must not proceed yet.
    expect(p.isSettled()).toBe(false);
    expect(rejoin).not.toHaveBeenCalled();

    // The abort lands: status settles, and (in the real wiring) the mirror's falling edge
    // releases the latch in this same commit.
    latchedRef.current = undefined;
    act(() => rerender({ status: 'ready', latched: undefined }));
    await p.flush();

    expect(p.isSettled()).toBe(true);
    expect(p.value()).toBe(true);
    expect(rejoin).toHaveBeenCalledTimes(1);
  });

  it('given the chat settles to error after stop, should also proceed (true)', async () => {
    const { result, rerender, rejoin, latchedRef } = setup({ status: 'streaming', latched: 'conv-1' });

    let prepare!: Promise<boolean>;
    act(() => {
      prepare = result.current.prepareSend('conv-2');
    });
    const p = probe(prepare);

    latchedRef.current = undefined;
    act(() => rerender({ status: 'error', latched: undefined }));
    await p.flush();

    expect(p.isSettled()).toBe(true);
    expect(p.value()).toBe(true);
    expect(rejoin).toHaveBeenCalledTimes(1);
  });

  it('given the status was already settled when prepareSend ran (late falling edge), should not wait', async () => {
    // Latch still set but status already 'ready' — the mirror effect will clear it this commit;
    // prepareSend must not deadlock waiting for a transition that already happened.
    const { result, stop, rejoin } = setup({ status: 'ready', latched: 'conv-1' });

    let ok = false;
    await act(async () => {
      ok = await result.current.prepareSend('conv-2');
    });

    expect(ok).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(rejoin).toHaveBeenCalledTimes(1);
  });

  // Timeout is NOT success by fiat (review finding, PR #2121): with the latch still held,
  // sending would hand the NEW send the OLD conversation's identity — the exact mis-keying this
  // hook exists to prevent. The caller must abort (and the composer un-wedges for a retry).
  it('given the status never settles AND the latch is still held, should resolve false after the safety timeout without rejoining', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result, rejoin } = setup({ status: 'streaming', latched: 'conv-1' });

    let prepare!: Promise<boolean>;
    act(() => {
      prepare = result.current.prepareSend('conv-2');
    });
    let value: boolean | undefined;
    void prepare.then((v) => { value = v; });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(value).toBe(false);
    expect(rejoin).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // The latch is the invariant, the status is only its proxy: if the mirror released the latch
  // but the status flush lagged past the timeout, the handoff IS safe — refusing here would
  // wedge a legitimate send.
  it('given the status never settles but the latch WAS released, should resolve true after the timeout and rejoin', async () => {
    vi.useFakeTimers();
    const { result, rejoin, latchedRef } = setup({ status: 'streaming', latched: 'conv-1' });

    let prepare!: Promise<boolean>;
    act(() => {
      prepare = result.current.prepareSend('conv-2');
    });
    let value: boolean | undefined;
    void prepare.then((v) => { value = v; });

    latchedRef.current = undefined;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(value).toBe(true);
    expect(rejoin).toHaveBeenCalledTimes(1);
  });

  it('given the hook unmounts mid-wait, should resolve false (nothing left to render the send)', async () => {
    const { result, rejoin, unmount } = setup({ status: 'streaming', latched: 'conv-1' });

    let prepare!: Promise<boolean>;
    act(() => {
      prepare = result.current.prepareSend('conv-2');
    });
    const p = probe(prepare);

    unmount();
    await p.flush();

    expect(p.isSettled()).toBe(true);
    expect(p.value()).toBe(false);
    expect(rejoin).not.toHaveBeenCalled();
  });
});

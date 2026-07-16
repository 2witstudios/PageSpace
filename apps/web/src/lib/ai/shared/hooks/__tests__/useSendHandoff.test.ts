import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { toast } from 'sonner';
import { useSendHandoff } from '../useSendHandoff';
import { useEditingStore } from '@/stores/useEditingStore';

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

describe('useSendHandoff', () => {
  beforeEach(() => {
    useEditingStore.getState().clearAllSessions();
    vi.clearAllMocks();
  });

  // The bug this replaces: the old wrapSend only had a synchronous try/catch around
  // `sendFn()`. When sendFn is `async () => { await contextPromise; sendMessage(...) }`
  // and contextPromise rejects, the rejection surfaces on the returned promise AFTER
  // wrapSend's try/catch has already returned — the catch never runs, useChat's status
  // never flips to 'error' (sendMessage was never reached), and pendingSend sits
  // registered until the 15s safety timeout fires with no visible error at all.
  it('given sendFn returns a promise that rejects, should end pendingSend immediately and surface an error (not wait for the 15s safety timeout)', async () => {
    const { result } = renderHook(() => useSendHandoff('conv-1', 'ready', false));

    await act(async () => {
      result.current.wrapSend(() => Promise.reject(new Error('network down')));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useEditingStore.getState().hasPendingSend('conv-1')).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
  });

  it('given sendFn throws synchronously, should end pendingSend and rethrow (existing behavior preserved)', () => {
    const { result } = renderHook(() => useSendHandoff('conv-1', 'ready', false));

    expect(() => {
      result.current.wrapSend(() => {
        throw new Error('sync boom');
      });
    }).toThrow('sync boom');

    expect(useEditingStore.getState().hasPendingSend('conv-1')).toBe(false);
  });

  it('given sendFn returns a promise that resolves, should NOT surface an error and should leave pendingSend for the streaming-status effect to clear', async () => {
    const { result } = renderHook(() => useSendHandoff('conv-1', 'ready', false));

    await act(async () => {
      result.current.wrapSend(() => Promise.resolve('ok'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toast.error).not.toHaveBeenCalled();
    expect(useEditingStore.getState().hasPendingSend('conv-1')).toBe(true);
  });

  // THE end-condition change (PR 5A, leaf 5.7). The handoff target is the STREAM ENTRY in
  // usePendingStreamsStore, not useChat's status.
  //
  // The old condition (`status === 'submitted' || 'streaming'`) ended the pendingSend the instant
  // useChat flipped to 'submitted' — which happens BEFORE the request is even issued, and 0.5-3s
  // before any stream exists. Nothing covered that gap except useChat's status itself, which is
  // exactly the signal this epic removes from the render path: it is idle for a bootstrapped
  // stream after a refresh and for every remote/cross-instance stream, so a pendingSend handing
  // off to it handed off to nothing.
  it('given the send is still in the submitted window with no stream entry yet, should KEEP pendingSend registered', async () => {
    // This test has to move the way a real send moves, or it cannot fail for the reason it exists.
    //
    // Two traps, both of which make it pass vacuously:
    //   1. Seeding `startPendingSend` directly instead of going through `wrapSend` — every clear
    //      path is guarded on the hook's internal pending ref, which only `wrapSend` sets, so the
    //      handoff effect short-circuits and nothing is ever exercised.
    //   2. Mounting at status='submitted' and never changing it — the handoff effect is keyed on
    //      [isStreamLive, status, conversationId], so it runs once at mount (before wrapSend) and
    //      never again. The old, WRONG end-condition would never get the chance to fire.
    //
    // So: mount at 'ready', wrapSend, THEN transition to 'submitted' — which is the transition the
    // old `status === 'submitted' || 'streaming'` condition cleared on, 0.5-3s too early and
    // before any stream existed. Verified failing against that condition by mutation.
    type Props = { status: 'ready' | 'submitted'; isStreamLive: boolean };
    const { result, rerender } = renderHook(
      ({ status, isStreamLive }: Props) => useSendHandoff('conv-1', status, isStreamLive),
      { initialProps: { status: 'ready', isStreamLive: false } as Props },
    );

    await act(async () => {
      result.current.wrapSend(() => Promise.resolve('ok'));
      await Promise.resolve();
    });

    // useChat flips to 'submitted' BEFORE it issues the request. No stream exists yet.
    await act(async () => {
      rerender({ status: 'submitted', isStreamLive: false });
    });

    expect(useEditingStore.getState().hasPendingSend('conv-1')).toBe(true);
    expect(result.current.pendingSendConversationId).toBe('conv-1');
  });

  it('given a stream entry appears for the conversation, should hand off and end pendingSend', async () => {
    const { result, rerender } = renderHook(
      ({ isStreamLive }) => useSendHandoff('conv-1', 'streaming', isStreamLive),
      { initialProps: { isStreamLive: false } },
    );

    await act(async () => {
      result.current.wrapSend(() => Promise.resolve('ok'));
      await Promise.resolve();
    });
    expect(useEditingStore.getState().hasPendingSend('conv-1')).toBe(true);

    await act(async () => {
      rerender({ isStreamLive: true });
    });

    expect(useEditingStore.getState().hasPendingSend('conv-1')).toBe(false);
  });

  // The pendingSend key is the conversation captured AT SEND — the only name Stop has during the
  // submitted window (see decideStopAction). It is exposed so the surface's Stop button can pass
  // it, rather than reaching for the surface's live conversation id, which may have moved.
  it('given an in-flight send, should expose the conversation it was made in', async () => {
    const { result } = renderHook(() => useSendHandoff('conv-1', 'ready', false));

    expect(result.current.pendingSendConversationId).toBeNull();

    await act(async () => {
      result.current.wrapSend(() => Promise.resolve('ok'));
      await Promise.resolve();
    });

    expect(result.current.pendingSendConversationId).toBe('conv-1');
  });

  it('given sendFn returns a plain synchronous (non-thenable) value, should not throw and should not touch the error toast', () => {
    const { result } = renderHook(() => useSendHandoff('conv-1', 'ready', false));

    const returned = result.current.wrapSend(() => 'plain-value');

    expect(returned).toBe('plain-value');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('given no conversationId, wrapSend should no-op and return undefined', () => {
    const { result } = renderHook(() => useSendHandoff(null, 'ready', false));

    const returned = result.current.wrapSend(() => Promise.reject(new Error('unreachable')));

    expect(returned).toBeUndefined();
  });
});

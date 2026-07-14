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
    const { result } = renderHook(() => useSendHandoff('conv-1', 'ready'));

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
    const { result } = renderHook(() => useSendHandoff('conv-1', 'ready'));

    expect(() => {
      result.current.wrapSend(() => {
        throw new Error('sync boom');
      });
    }).toThrow('sync boom');

    expect(useEditingStore.getState().hasPendingSend('conv-1')).toBe(false);
  });

  it('given sendFn returns a promise that resolves, should NOT surface an error and should leave pendingSend for the streaming-status effect to clear', async () => {
    const { result } = renderHook(() => useSendHandoff('conv-1', 'ready'));

    await act(async () => {
      result.current.wrapSend(() => Promise.resolve('ok'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toast.error).not.toHaveBeenCalled();
    expect(useEditingStore.getState().hasPendingSend('conv-1')).toBe(true);
  });

  it('given sendFn returns a plain synchronous (non-thenable) value, should not throw and should not touch the error toast', () => {
    const { result } = renderHook(() => useSendHandoff('conv-1', 'ready'));

    const returned = result.current.wrapSend(() => 'plain-value');

    expect(returned).toBe('plain-value');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('given no conversationId, wrapSend should no-op and return undefined', () => {
    const { result } = renderHook(() => useSendHandoff(null, 'ready'));

    const returned = result.current.wrapSend(() => Promise.reject(new Error('unreachable')));

    expect(returned).toBeUndefined();
  });
});

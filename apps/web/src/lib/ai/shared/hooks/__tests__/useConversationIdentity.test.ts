import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useConversationIdentity } from '../useConversationIdentity';

describe('useConversationIdentity', () => {
  it('given the hook mounts, should dispatch RESOLVE_STARTED then RESOLVED once resolve() settles', async () => {
    const resolve = vi.fn().mockResolvedValue({ conversationId: 'conv-1' });
    const { result } = renderHook(() => useConversationIdentity({ resolve }));

    expect(result.current.state.status).toBe('resolving');
    expect(result.current.canSend).toBe(false);

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'ready', conversationId: 'conv-1' });
    });
    expect(result.current.canSend).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('given resolve() rejects, should end in error state with canSend false', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useConversationIdentity({ resolve }));

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'error', message: 'network down' });
    });
    expect(result.current.canSend).toBe(false);
  });

  it('given setIdentity is called, should transition straight to ready synchronously — no dependency on resolve() settling', async () => {
    let resolveFn!: (value: { conversationId: string }) => void;
    const resolve = vi.fn(() => new Promise<{ conversationId: string }>((r) => { resolveFn = r; }));
    const { result } = renderHook(() => useConversationIdentity({ resolve }));

    expect(result.current.state.status).toBe('resolving');

    act(() => {
      result.current.setIdentity('new-conv');
    });

    expect(result.current.state).toEqual({ status: 'ready', conversationId: 'new-conv' });
    expect(result.current.canSend).toBe(true);

    // A late resolve() from the original in-flight call must not clobber it.
    await act(async () => {
      resolveFn({ conversationId: 'stale-conv' });
      await Promise.resolve();
    });
    expect(result.current.state).toEqual({ status: 'ready', conversationId: 'new-conv' });
  });

  it('given retry is called from error state, should re-invoke resolve() and recover to ready', async () => {
    const resolve = vi.fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce({ conversationId: 'conv-2' });
    const { result } = renderHook(() => useConversationIdentity({ resolve }));

    await waitFor(() => {
      expect(result.current.state.status).toBe('error');
    });

    act(() => {
      result.current.retry();
    });
    expect(result.current.state.status).toBe('resolving');

    await waitFor(() => {
      expect(result.current.state).toEqual({ status: 'ready', conversationId: 'conv-2' });
    });
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

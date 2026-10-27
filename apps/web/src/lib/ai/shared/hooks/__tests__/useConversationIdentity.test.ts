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

  // The reducer already drops a stale RESOLVED, but `isPersisted` lives in React state
  // OUTSIDE the reducer and needed the same protection explicitly. Without it, a resolve
  // still in flight when the user picks a conversation from History lands afterwards and
  // flips isPersisted — and the AI-page loaders SKIP a conversation they believe has no
  // server-side rows, so the user stares at an empty chat for a real conversation.
  describe('a stale resolve must not clobber isPersisted', () => {
    it('given the user selects a persisted conversation while a resolve is in flight, the late resolve should NOT flip isPersisted to false', async () => {
      let settle!: (r: { conversationId: string; isPersisted?: boolean }) => void;
      const resolve = vi.fn(() => new Promise<{ conversationId: string; isPersisted?: boolean }>((res) => { settle = res; }));

      const { result } = renderHook(() => useConversationIdentity({ resolve }));
      expect(result.current.state.status).toBe('resolving');

      // The user picks a real conversation from History before the resolve lands.
      act(() => { result.current.setIdentity('conv-from-history', { isPersisted: true }); });
      expect(result.current.isPersisted).toBe(true);

      // The stale resolve now lands, claiming a brand-new (unpersisted) conversation.
      await act(async () => {
        settle({ conversationId: 'conv-fresh', isPersisted: false });
        await Promise.resolve();
      });

      expect(result.current.state).toEqual({ status: 'ready', conversationId: 'conv-from-history' });
      expect(result.current.isPersisted).toBe(true);
    });

    it('given no interleaving setIdentity, the resolve should still apply its isPersisted', async () => {
      const resolve = vi.fn().mockResolvedValue({ conversationId: 'conv-fresh', isPersisted: false });

      const { result } = renderHook(() => useConversationIdentity({ resolve }));

      await waitFor(() => expect(result.current.state.status).toBe('ready'));
      expect(result.current.isPersisted).toBe(false);
    });

    it('given a resolve result with no isPersisted field, should default to true', async () => {
      const resolve = vi.fn().mockResolvedValue({ conversationId: 'conv-1' });

      const { result } = renderHook(() => useConversationIdentity({ resolve }));

      await waitFor(() => expect(result.current.state.status).toBe('ready'));
      expect(result.current.isPersisted).toBe(true);
    });
  });
});

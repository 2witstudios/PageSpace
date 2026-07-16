import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMessageActions } from '../useMessageActions';

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: vi.fn(),
  patch: vi.fn(),
  del: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/ai/core/browser-session-id', () => ({
  getBrowserSessionId: vi.fn().mockReturnValue('session-1'),
}));

describe('useMessageActions — handleRetry regenerate body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given global mode (agentId null), should include conversationId in the regenerate body — not send undefined', async () => {
    const regenerate = vi.fn();
    const { result } = renderHook(() =>
      useMessageActions({
        agentId: null,
        conversationId: 'global-conv-1',
        messages: [],
        setMessages: vi.fn(),
        regenerate,
      })
    );

    await act(async () => {
      await result.current.handleRetry();
    });

    expect(regenerate).toHaveBeenCalledWith({ body: { conversationId: 'global-conv-1' } });
  });

  it('given global mode and the conversation changes between renders, should regenerate with the NEW conversationId', async () => {
    const regenerate = vi.fn();
    const { result, rerender } = renderHook(
      ({ conversationId }) =>
        useMessageActions({
          agentId: null,
          conversationId,
          messages: [],
          setMessages: vi.fn(),
          regenerate,
        }),
      { initialProps: { conversationId: 'conv-first' } }
    );

    rerender({ conversationId: 'conv-second' });

    await act(async () => {
      await result.current.handleRetry();
    });

    expect(regenerate).toHaveBeenCalledWith({ body: { conversationId: 'conv-second' } });
  });

  it('given agent mode, should include chatId and conversationId in the regenerate body (existing behavior)', async () => {
    const regenerate = vi.fn();
    const { result } = renderHook(() =>
      useMessageActions({
        agentId: 'agent-1',
        conversationId: 'agent-conv-1',
        messages: [],
        setMessages: vi.fn(),
        regenerate,
      })
    );

    await act(async () => {
      await result.current.handleRetry();
    });

    expect(regenerate).toHaveBeenCalledWith({
      body: { chatId: 'agent-1', conversationId: 'agent-conv-1' },
    });
  });
});

describe('useMessageActions — handleEdit reconcile refetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const editArgs = { messageId: 'm-old', newContent: 'edited' };

  const renderEdit = (isOwnStreamLive: boolean, setMessages: ReturnType<typeof vi.fn>) =>
    renderHook(() =>
      useMessageActions({
        agentId: null,
        conversationId: 'conv-1',
        messages: [{ id: 'm-old', role: 'user', parts: [{ type: 'text', text: 'before' }] }] as never,
        setMessages,
        regenerate: vi.fn(),
        isOwnStreamLive,
      }),
    );

  // The refetch replaces the WHOLE array, and useOwnStreamMirror reads that array to find its own
  // live stream. DB history whose newest row is a foreign assistant message — another TAB of this
  // same user counts, since `isOwn` is browserSessionId-scoped — makes the mirror re-target onto a
  // finished message: our live entry goes, and Stop then aborts an id the server has no stream for
  // (user-scoped → not_found → silent by design) while the generation keeps running its write
  // tools and keeps billing.
  //
  // Skipping it costs nothing: the edit is applied optimistically and the server already has it —
  // this refetch is explicitly non-critical reconciliation, and the next load re-syncs the array.
  it('given our own stream is live, should NOT replace the whole array with the refetched history', async () => {
    const { patch } = await import('@/lib/auth/auth-fetch');
    vi.mocked(patch).mockResolvedValue({ ok: true, json: async () => ({}) } as never);
    const { fetchWithAuth } = await import('@/lib/auth/auth-fetch');
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'someone-elses-reply', role: 'assistant', parts: [] }] }),
    } as never);

    const setMessages = vi.fn();
    const { result } = renderEdit(true, setMessages);

    await act(async () => { await result.current.handleEdit(editArgs.messageId, editArgs.newContent); });

    const wroteRefetchedHistory = setMessages.mock.calls.some(([arg]) =>
      Array.isArray(arg) && arg.some((m: { id: string }) => m.id === 'someone-elses-reply'),
    );
    expect(wroteRefetchedHistory).toBe(false);
  });

  // ...and with no own stream live it still reconciles, or the refetch would be pointless.
  it('given no own stream is live, should replace the array with the refetched history', async () => {
    const { patch } = await import('@/lib/auth/auth-fetch');
    vi.mocked(patch).mockResolvedValue({ ok: true, json: async () => ({}) } as never);
    const { fetchWithAuth } = await import('@/lib/auth/auth-fetch');
    vi.mocked(fetchWithAuth).mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'server-truth', role: 'assistant', parts: [] }] }),
    } as never);

    const setMessages = vi.fn();
    const { result } = renderEdit(false, setMessages);

    await act(async () => { await result.current.handleEdit(editArgs.messageId, editArgs.newContent); });

    const wroteRefetchedHistory = setMessages.mock.calls.some(([arg]) =>
      Array.isArray(arg) && arg.some((m: { id: string }) => m.id === 'server-truth'),
    );
    expect(wroteRefetchedHistory).toBe(true);
  });
});

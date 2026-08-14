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

// THE 'handleEdit reconcile refetch' DESCRIBE WAS HERE.
//
// It pinned a post-edit refetch that replaced useChat's WHOLE messages array with fresh DB
// history, guarded by `isOwnStreamLive` because that array was the own-stream mirror's read
// source — DB history whose newest row was a foreign assistant message made the mirror
// re-target onto a finished message, so the live entry went and Stop named an id the server
// had no stream for.
//
// Both the refetch and the guard are deleted. There is no transport array to replace, and the
// cache — which is what renders — is written from the edit itself by `useCacheMessageActions`.
// A whole-conversation refetch to update a container nothing reads is not behaviour worth
// keeping a test for; the refetch's own comment called it "non-critical" reconciliation.

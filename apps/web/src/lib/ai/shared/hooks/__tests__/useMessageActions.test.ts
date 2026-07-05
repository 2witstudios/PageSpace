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

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSideQuestion } from '../useSideQuestion';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth/auth-fetch', () => ({ fetchWithAuth: fetchMock }));

// The registration only mirrors streaming state into the editing store —
// irrelevant to the conversation-switch teardown under test here.
vi.mock('@/lib/ai/shared', () => ({ useStreamingRegistration: vi.fn() }));

const streamResponse = (chunks: string[]) => {
  let i = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
            : { done: true, value: undefined },
      }),
    },
  };
};

/**
 * All three wired surfaces (SessionChat, GlobalAssistantView, SidebarChatTab)
 * share this hook, so the conversation-switch teardown must live here: a card
 * from the previous conversation — completed or aborted mid-"Thinking…" —
 * must never survive into the next conversation.
 */
describe('useSideQuestion — conversation switch teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears a completed card when the conversation changes', async () => {
    fetchMock.mockResolvedValue(streamResponse(['partial answer']));
    const { result, rerender } = renderHook(
      ({ conversationId }) => useSideQuestion(conversationId),
      { initialProps: { conversationId: 'conv-1' } }
    );
    await act(async () => {
      await result.current.ask('Why?');
    });
    await waitFor(() => expect(result.current.state?.loading).toBe(false));
    expect(result.current.state?.text).toBe('partial answer');

    rerender({ conversationId: 'conv-2' });
    expect(result.current.state).toBeNull();
  });

  it('clears an in-flight card and aborts the stream when the conversation changes', async () => {
    let capturedSignal: AbortSignal | null | undefined;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal;
      return new Promise(() => {}); // never resolves: the stream stays in flight
    });
    const { result, rerender } = renderHook(
      ({ conversationId }) => useSideQuestion(conversationId),
      { initialProps: { conversationId: 'conv-1' } }
    );
    act(() => {
      void result.current.ask('Why?');
    });
    await waitFor(() => expect(result.current.state?.loading).toBe(true));

    rerender({ conversationId: 'conv-2' });
    expect(result.current.state).toBeNull();
    // Abort propagates through the request signal to cancel the server stream.
    expect(capturedSignal?.aborted).toBe(true);
  });
});

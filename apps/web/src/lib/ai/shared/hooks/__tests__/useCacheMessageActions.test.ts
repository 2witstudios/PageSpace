import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { useCacheMessageActions } from '../useCacheMessageActions';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import type { RenderedMessage } from '@/lib/ai/streams/selectRenderedMessages';

// vi.mock factories are hoisted above module-scope declarations — a plain `let` here would
// throw a TDZ ReferenceError at transform time. vi.hoisted lifts this state alongside the mock.
const mockState = vi.hoisted(() => ({
  handleRetryBaseResolve: undefined as (() => void) | undefined,
}));

vi.mock('../useMessageActions', () => ({
  useMessageActions: () => ({
    handleEdit: vi.fn(),
    handleDelete: vi.fn(),
    // A real regenerate's underlying Promise resolves only once the new stream finishes
    // (ai SDK makeRequest reads the response to completion) — held open here so the test
    // can assert applyDelete already ran BEFORE this resolves (PR 6 review, CodeRabbit).
    handleRetry: vi.fn(() => new Promise<void>((resolve) => { mockState.handleRetryBaseResolve = resolve; })),
  }),
}));

const userMsg = (id: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text: 'hi' }] });
const assistantMsg = (id: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text: 'reply' }] });

describe('useCacheMessageActions handleRetry', () => {
  beforeEach(() => {
    mockState.handleRetryBaseResolve = undefined;
  });

  it('given a retry, should apply the cache deletes BEFORE handleRetryBase (regenerate) settles, not after', async () => {
    const applyDeleteSpy = vi.spyOn(conversationMessagesActions, 'applyDelete').mockImplementation(() => {});
    const renderedMessages: RenderedMessage[] = [
      { mode: 'confirmed', message: userMsg('u1') },
      { mode: 'confirmed', message: assistantMsg('a1') },
    ];

    const { result } = renderHook(() =>
      useCacheMessageActions({
        agentId: 'agent-1',
        conversationId: 'conv-1',
        renderedMessages,
        isOwnSendLive: false,
        setMessages: vi.fn(),
        regenerate: vi.fn(),
      }),
    );

    let retryPromise: Promise<void> | undefined;
    act(() => {
      retryPromise = result.current.handleRetry();
    });

    // handleRetryBase's promise is still pending (held open above) — the delete must
    // already have happened, not be waiting on it.
    expect(applyDeleteSpy).toHaveBeenCalledWith('conv-1', 'a1');

    mockState.handleRetryBaseResolve?.();
    await act(async () => {
      await retryPromise;
    });
  });

  it('given a live stream anywhere in the rendered list, should plan no deletion (planRetry guard) and not call applyDelete', async () => {
    const applyDeleteSpy = vi.spyOn(conversationMessagesActions, 'applyDelete').mockImplementation(() => {});
    const renderedMessages: RenderedMessage[] = [
      { mode: 'confirmed', message: userMsg('u1') },
      { mode: 'streaming', message: assistantMsg('a1') },
    ];

    const { result } = renderHook(() =>
      useCacheMessageActions({
        agentId: 'agent-1',
        conversationId: 'conv-1',
        renderedMessages,
        isOwnSendLive: true,
        setMessages: vi.fn(),
        regenerate: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.handleRetry();
    });

    expect(applyDeleteSpy).not.toHaveBeenCalled();
  });
});

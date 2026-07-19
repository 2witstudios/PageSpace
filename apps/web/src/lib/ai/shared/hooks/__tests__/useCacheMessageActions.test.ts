import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { useCacheMessageActions, type UseCacheMessageActionsOptions } from '../useCacheMessageActions';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';

// vi.mock factories are hoisted above module-scope declarations — a plain `let` here would
// throw a TDZ ReferenceError at transform time. vi.hoisted lifts this state alongside the mock.
const mockState = vi.hoisted(() => ({
  handleRetryBaseResolve: undefined as (() => void) | undefined,
  handleRetryBase: undefined as ReturnType<typeof vi.fn> | undefined,
}));

vi.mock('../useMessageActions', () => ({
  useMessageActions: () => ({
    handleEdit: vi.fn(),
    handleDelete: vi.fn(),
    // A real regenerate's underlying Promise resolves only once the new stream finishes
    // (ai SDK makeRequest reads the response to completion) — held open here so the test
    // can assert applyDelete already ran BEFORE this resolves (PR 6 review, CodeRabbit).
    handleRetry: (mockState.handleRetryBase = vi.fn(
      () => new Promise<void>((resolve) => { mockState.handleRetryBaseResolve = resolve; }),
    )),
  }),
}));

const userMsg = (id: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text: 'hi' }] });
const assistantMsg = (id: string): UIMessage => ({ id, role: 'assistant', parts: [{ type: 'text', text: 'reply' }] });

const baseOptions = (
  overrides: Partial<UseCacheMessageActionsOptions> = {},
): UseCacheMessageActionsOptions => ({
  agentId: 'agent-1',
  conversationId: 'conv-1',
  renderedMessages: [
    { mode: 'confirmed', message: userMsg('u1') },
    { mode: 'confirmed', message: assistantMsg('a1') },
  ],
  isOwnSendLive: false,
  setMessages: vi.fn(),
  regenerate: vi.fn(),
  prepareSend: vi.fn().mockResolvedValue(true),
  getIsOwnSendLive: () => false,
  ...overrides,
});

describe('useCacheMessageActions handleRetry', () => {
  beforeEach(() => {
    mockState.handleRetryBaseResolve = undefined;
  });

  it('given a retry, should apply the cache deletes BEFORE handleRetryBase (regenerate) settles, not after', async () => {
    const applyDeleteSpy = vi.spyOn(conversationMessagesActions, 'applyDelete').mockImplementation(() => {});

    const { result } = renderHook(() => useCacheMessageActions(baseOptions()));

    let retryPromise: Promise<void> | undefined;
    act(() => {
      retryPromise = result.current.handleRetry();
    });
    // The handoff (prepareSend) resolves in a microtask before the deletes run.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // handleRetryBase's promise is still pending (held open above) — the delete must
    // already have happened, not be waiting on it.
    expect(applyDeleteSpy).toHaveBeenCalledWith('conv-1', 'a1');

    mockState.handleRetryBaseResolve?.();
    await act(async () => {
      await retryPromise;
    });
    applyDeleteSpy.mockRestore();
  });

  it('given a live stream anywhere in the rendered list, should plan no deletion (planRetry guard) and not call applyDelete', async () => {
    const applyDeleteSpy = vi.spyOn(conversationMessagesActions, 'applyDelete').mockImplementation(() => {});

    const { result } = renderHook(() =>
      useCacheMessageActions(
        baseOptions({
          renderedMessages: [
            { mode: 'confirmed', message: userMsg('u1') },
            { mode: 'streaming', message: assistantMsg('a1') },
          ],
          isOwnSendLive: true,
          getIsOwnSendLive: () => true,
        }),
      ),
    );

    await act(async () => {
      await result.current.handleRetry();
    });

    expect(applyDeleteSpy).not.toHaveBeenCalled();
    applyDeleteSpy.mockRestore();
  });

  // Retry is a send (dual-stream fix): the handoff runs BEFORE the destructive steps, so a
  // refused handoff must delete nothing and regenerate nothing — the retry is simply aborted.
  it('given a refused handoff, should delete nothing and never reach handleRetryBase', async () => {
    const applyDeleteSpy = vi.spyOn(conversationMessagesActions, 'applyDelete').mockImplementation(() => {});
    const setMessages = vi.fn();
    const prepareSend = vi.fn().mockResolvedValue(false);

    const { result } = renderHook(() =>
      useCacheMessageActions(baseOptions({ prepareSend, setMessages })),
    );

    await act(async () => {
      await result.current.handleRetry();
    });

    expect(prepareSend).toHaveBeenCalledWith('conv-1');
    expect(applyDeleteSpy).not.toHaveBeenCalled();
    expect(setMessages).not.toHaveBeenCalled();
    expect(mockState.handleRetryBase).not.toHaveBeenCalled();
    applyDeleteSpy.mockRestore();
  });

  // THE cross-conversation retry leak (workflow review, CONFIRMED): while the chat consumed
  // conversation A's stream, the render-captured isOwnSendLive said "busy" and skipped
  // hydration — regenerate then re-sent A's stale transport trail under B's body. The hydrate
  // decision must use the POST-HANDOFF liveness (the ref-reader), which reads false once the
  // handoff settles the chat.
  it('given the render-captured liveness says busy but the post-handoff read says settled, should hydrate the transport before regenerating', async () => {
    const applyDeleteSpy = vi.spyOn(conversationMessagesActions, 'applyDelete').mockImplementation(() => {});
    const setMessages = vi.fn();
    // Render-captured: busy (chat was consuming another conversation). Live read: settled.
    const { result } = renderHook(() =>
      useCacheMessageActions(
        baseOptions({
          setMessages,
          isOwnSendLive: true,
          getIsOwnSendLive: () => false,
        }),
      ),
    );

    act(() => {
      void result.current.handleRetry();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // Hydration ran with the settled rows — the regenerate acts on THIS conversation's trail.
    expect(setMessages).toHaveBeenCalledWith([userMsg('u1'), assistantMsg('a1')]);

    mockState.handleRetryBaseResolve?.();
    applyDeleteSpy.mockRestore();
  });
});

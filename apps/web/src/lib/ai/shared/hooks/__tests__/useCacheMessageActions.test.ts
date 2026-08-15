import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { useCacheMessageActions, type UseCacheMessageActionsOptions } from '../useCacheMessageActions';
import { conversationMessagesActions } from '@/hooks/conversationMessagesActions';
import { useEditingStore } from '@/stores/useEditingStore';

// vi.mock factories are hoisted above module-scope declarations — a plain `let` here would
// throw a TDZ ReferenceError at transform time. vi.hoisted lifts this state alongside the mock.
const mockState = vi.hoisted(() => {
  const state = {
    handleRetryBaseResolve: undefined as (() => void) | undefined,
    handleRetryBase: undefined as ReturnType<typeof vi.fn> | undefined,
  };
  // ONE spy for the life of the file, not a fresh one per render. The hook re-renders (and
  // re-invokes this factory) on every prop change, so a spy created inside it silently reset
  // its own call count mid-test — which is invisible until a test spans a re-render.
  //
  // A real regenerate's underlying Promise resolves only once the new stream finishes
  // (ai SDK makeRequest reads the response to completion) — held open here so the test
  // can assert applyDelete already ran BEFORE this resolves (PR 6 review, CodeRabbit).
  state.handleRetryBase = vi.fn(
    () => new Promise<void>((resolve) => { state.handleRetryBaseResolve = resolve; }),
  );
  return state;
});

vi.mock('../useMessageActions', () => ({
  useMessageActions: () => ({
    handleEdit: vi.fn(),
    handleDelete: vi.fn(),
    handleRetry: mockState.handleRetryBase,
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
  regenerate: vi.fn(),
  wrapSend: makeWrapSend(overrides.conversationId === undefined ? 'conv-1' : overrides.conversationId),
  ...overrides,
});

/**
 * Faithful to `useSendHandoff.wrapSend`, because the retry latch now IS its pendingSend
 * registration: it registers synchronously, keyed by conversation, before invoking the send.
 * A bare passthrough here would silently disable the very guard these cases exercise.
 */
const makeWrapSend = (conversationId: string | null) => <T,>(sendFn: () => T): T | undefined => {
  if (!conversationId) return undefined;
  useEditingStore.getState().startPendingSend(conversationId);
  return sendFn();
};

describe('useCacheMessageActions handleRetry', () => {
  beforeEach(() => {
    mockState.handleRetryBaseResolve = undefined;
    useEditingStore.setState({ pendingSends: new Set() });
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
  // TWO CASES WERE HERE, both pinning mechanisms that are gone.
  //
  // 'given a refused handoff, should delete nothing…' pinned `prepareSend` running before
  // Retry's destructive steps, so a refusal orphaned nothing. There is no handoff and no
  // refusal now — see `useAnswerAskUser`'s note for why.
  //
  // 'given the render-captured liveness says busy but the post-handoff read says settled,
  // should hydrate the transport…' pinned `hydrateTransportBeforeReinvoke` plus the
  // ref-reader that decided WHEN to run it. There is no transport array to hydrate:
  // `regenerate` composes its request from the store's settled view at call time, which is
  // what that hydration was manually arranging. The cross-conversation content leak it
  // guarded against needed a shared `Chat` to be possible at all.

  // Retry never went through the surface's optimistic path: `regenerate` was called bare, so
  // pendingSendConversationId stayed null, every surface's displayIsStreaming stayed FALSE for
  // the whole window, and the composer sat there with an enabled textarea and a Send button
  // while a regeneration was already under way.
  it('given a retry, should issue it through wrapSend so the composer locks like a send', async () => {
    const applyDeleteSpy = vi.spyOn(conversationMessagesActions, 'applyDelete').mockImplementation(() => {});
    // Counted around the wrapped call: proves the retry runs INSIDE the registration rather
    // than merely after it, which is the whole point — the composer has to be locked while the
    // network work happens, not once it is done.
    let retriesBeforeInner = -1;
    let retriesAfterInner = -1;
    let wrapSendCalls = 0;
    // Not vi.fn: wrapping erases the generic, and `wrapSend` has to stay generic to satisfy
    // the option's signature.
    const inner = makeWrapSend('conv-1');
    const wrapSend = <T,>(sendFn: () => T): T | undefined => {
      wrapSendCalls += 1;
      retriesBeforeInner = mockState.handleRetryBase?.mock.calls.length ?? -1;
      const returned = inner(sendFn);
      retriesAfterInner = mockState.handleRetryBase?.mock.calls.length ?? -1;
      return returned;
    };

    const { result } = renderHook(() => useCacheMessageActions(baseOptions({ wrapSend })));
    mockState.handleRetryBase?.mockClear();

    act(() => { void result.current.handleRetry(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(wrapSendCalls).toBe(1);
    expect(retriesBeforeInner).toBe(0);
    expect(retriesAfterInner).toBe(1);

    mockState.handleRetryBaseResolve?.();
    applyDeleteSpy.mockRestore();
  });

  // Double-click. Every other guard is state-derived and only closes after a render, so both
  // clicks land inside the same await window — two regenerations, billed twice.
  it('given a second retry while the first is still in flight, should fire only one regenerate', async () => {
    const applyDeleteSpy = vi.spyOn(conversationMessagesActions, 'applyDelete').mockImplementation(() => {});
    let wrapSendCalls = 0;
    const inner = makeWrapSend('conv-1');
    const wrapSend = <T,>(sendFn: () => T): T | undefined => {
      wrapSendCalls += 1;
      return inner(sendFn);
    };

    const { result } = renderHook(() => useCacheMessageActions(baseOptions({ wrapSend })));
    mockState.handleRetryBase?.mockClear();

    act(() => {
      void result.current.handleRetry();
      void result.current.handleRetry();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(wrapSendCalls).toBe(1);
    expect(mockState.handleRetryBase).toHaveBeenCalledTimes(1);

    mockState.handleRetryBaseResolve?.();
    applyDeleteSpy.mockRestore();
  });

  // The dashboard and sidebar keep ONE instance of this hook across a conversation switch, and
  // concurrent sends in different conversations are supported by design. A single boolean latch
  // let a retry still awaiting A's DELETEs silently swallow a Retry click in B.
  it('given a retry in flight for one conversation, should not block a retry in another', async () => {
    const applyDeleteSpy = vi.spyOn(conversationMessagesActions, 'applyDelete').mockImplementation(() => {});

    const { result, rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) =>
        useCacheMessageActions(
          baseOptions({ conversationId, wrapSend: makeWrapSend(conversationId) }),
        ),
      { initialProps: { conversationId: 'conv-1' } },
    );
    mockState.handleRetryBase?.mockClear();

    // A's retry is in flight — handleRetryBase's promise is held open, so the latch is still set.
    act(() => { void result.current.handleRetry(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockState.handleRetryBase).toHaveBeenCalledTimes(1);

    // Same hook instance, conversation B now on screen.
    rerender({ conversationId: 'conv-2' });
    act(() => { void result.current.handleRetry(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(mockState.handleRetryBase).toHaveBeenCalledTimes(2);

    mockState.handleRetryBaseResolve?.();
    applyDeleteSpy.mockRestore();
  });

  // The cross-SURFACE case (CodeRabbit). GlobalAssistantView and SidebarChatTab each mount
  // their own instance of this hook for the same conversation, so a per-instance ref left two
  // Retry buttons unaware of each other. The server cannot save us there: its per-conversation
  // takeover is a check-then-act and says so — "two near-simultaneous sends can BOTH find zero
  // in-flight rows and BOTH proceed: two generations, two sets of tool calls, two bills".
  it('given two hook instances on the same conversation, should run only one retry', async () => {
    const applyDeleteSpy = vi.spyOn(conversationMessagesActions, 'applyDelete').mockImplementation(() => {});

    // Two independent mounts, exactly as the dashboard and the sidebar produce.
    const dashboard = renderHook(() => useCacheMessageActions(baseOptions()));
    const sidebar = renderHook(() => useCacheMessageActions(baseOptions()));
    mockState.handleRetryBase?.mockClear();

    act(() => { void dashboard.result.current.handleRetry(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockState.handleRetryBase).toHaveBeenCalledTimes(1);

    // The other surface's Retry, while the first is still in flight.
    act(() => { void sidebar.result.current.handleRetry(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(mockState.handleRetryBase).toHaveBeenCalledTimes(1);

    mockState.handleRetryBaseResolve?.();
    applyDeleteSpy.mockRestore();
  });
});

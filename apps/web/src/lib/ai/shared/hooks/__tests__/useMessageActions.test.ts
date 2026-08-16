import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { del, ApiRequestError } from '@/lib/auth/auth-fetch';
import { toast } from 'sonner';
import { recordStopRequest } from '@/lib/ai/streams/stopRequests';
import { useMessageActions, type RetryOutcome } from '../useMessageActions';

// Partial: `ApiRequestError` is a real class the hook does an `instanceof` against, so a stub
// would make every rejection look like a plain Error and collapse the 404 distinction under test.
vi.mock('@/lib/auth/auth-fetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/auth-fetch')>()),
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

/**
 * THE STOP THE SERVER CANNOT HONOUR.
 *
 * Retry now runs inside `wrapSend`, so the composer offers Stop for the whole DELETE round trip
 * below — but no stream row exists yet, so `markAbortRequested` matches nothing and the abort
 * answers `not_found`, which the UI is deliberately silent about. Dispatching the regenerate
 * anyway would mean the press did nothing visible and a generation started regardless.
 */
describe('useMessageActions — handleRetry and a Stop mid-DELETE', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const assistantAfterUser = (): UIMessage[] => [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'reply' }] },
  ];

  it('given a Stop while the superseded rows are being deleted, should not regenerate', async () => {
    const regenerate = vi.fn();
    let releaseDeletes: (() => void) | undefined;
    vi.mocked(del).mockImplementation(
      () => new Promise((resolve) => { releaseDeletes = () => resolve(undefined); }),
    );

    const { result } = renderHook(() =>
      useMessageActions({
        agentId: null,
        conversationId: 'conv-1',
        messages: assistantAfterUser(),
        regenerate,
      }),
    );

    let retry: Promise<RetryOutcome> | undefined;
    act(() => { retry = result.current.handleRetry(); });

    // The press, landing while the DELETEs are still in flight — exactly the window the
    // composer has been showing Stop for.
    act(() => { recordStopRequest('conv-1'); });

    await act(async () => { releaseDeletes?.(); await retry; });

    expect(regenerate).not.toHaveBeenCalled();
    // Named, not merely false: the caller releases the pendingSend on every non-dispatch, but
    // only a delete failure additionally means the cache is lying about what the server holds.
    await expect(retry).resolves.toEqual({ dispatched: false, reason: 'stopped' });
  });

  // The mirror image, and the reason this is a counter compared against a snapshot rather than a
  // flag anyone has to clear: stopping a stream and THEN retrying it is the ordinary path.
  it('given a Stop that happened BEFORE the retry, should still regenerate', async () => {
    const regenerate = vi.fn();
    vi.mocked(del).mockResolvedValue(undefined);

    recordStopRequest('conv-2');

    const { result } = renderHook(() =>
      useMessageActions({
        agentId: null,
        conversationId: 'conv-2',
        messages: assistantAfterUser(),
        regenerate,
      }),
    );

    await act(async () => { await result.current.handleRetry(); });

    expect(regenerate).toHaveBeenCalledWith({ body: { conversationId: 'conv-2' } });
  });

  // A FAILED delete breaks the same invariant as a raced one: the row is still in the database,
  // the server rebuilds history FROM the database, and the model gets its own previous answer as
  // the newest turn. Awaiting something and then ignoring what it said is not an ordering
  // guarantee (CodeRabbit).
  it('given a delete that fails, should not regenerate', async () => {
    const regenerate = vi.fn();
    vi.mocked(del).mockRejectedValue(new Error('500'));

    const { result } = renderHook(() =>
      useMessageActions({
        agentId: null,
        conversationId: 'conv-4',
        messages: assistantAfterUser(),
        regenerate,
      }),
    );

    let outcome: RetryOutcome | undefined;
    await act(async () => { outcome = await result.current.handleRetry(); });

    expect(regenerate).not.toHaveBeenCalled();
    expect(outcome).toEqual({ dispatched: false, reason: 'delete-failed' });
    // Not silent: the cache row is already gone, so the user would otherwise watch their answer
    // vanish with nothing replacing it and no idea why.
    expect(toast.error).toHaveBeenCalled();
  });

  // 404 is not a failure here, and conflating them would be its own bug: the route answers
  // 'Message not found' for a row that is already gone, and gone is the state the delete was
  // asking for. A collaborator or a second tab getting there first must not block the retry.
  it('given a delete that 404s because the row is already gone, should still regenerate', async () => {
    const regenerate = vi.fn();
    vi.mocked(del).mockRejectedValue(new ApiRequestError('Message not found', 404));

    const { result } = renderHook(() =>
      useMessageActions({
        agentId: null,
        conversationId: 'conv-6',
        messages: assistantAfterUser(),
        regenerate,
      }),
    );

    await act(async () => { await result.current.handleRetry(); });

    expect(regenerate).toHaveBeenCalledWith({ body: { conversationId: 'conv-6' } });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('given every delete succeeds, should regenerate and say nothing', async () => {
    const regenerate = vi.fn();
    vi.mocked(del).mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useMessageActions({
        agentId: null,
        conversationId: 'conv-5',
        messages: assistantAfterUser(),
        regenerate,
      }),
    );

    await act(async () => { await result.current.handleRetry(); });

    expect(regenerate).toHaveBeenCalledWith({ body: { conversationId: 'conv-5' } });
    expect(toast.error).not.toHaveBeenCalled();
  });

  // Keyed by conversation for the same reason everything else in this path is: concurrent sends
  // in different conversations are supported by design.
  it('given a Stop in another conversation, should still regenerate this one', async () => {
    const regenerate = vi.fn();
    let releaseDeletes: (() => void) | undefined;
    vi.mocked(del).mockImplementation(
      () => new Promise((resolve) => { releaseDeletes = () => resolve(undefined); }),
    );

    const { result } = renderHook(() =>
      useMessageActions({
        agentId: null,
        conversationId: 'conv-3',
        messages: assistantAfterUser(),
        regenerate,
      }),
    );

    let retry: Promise<RetryOutcome> | undefined;
    act(() => { retry = result.current.handleRetry(); });
    act(() => { recordStopRequest('conv-elsewhere'); });

    await act(async () => { releaseDeletes?.(); await retry; });

    expect(regenerate).toHaveBeenCalledWith({ body: { conversationId: 'conv-3' } });
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

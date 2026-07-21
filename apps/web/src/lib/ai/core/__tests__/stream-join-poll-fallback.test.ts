import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFetchWithAuth } = vi.hoisted(() => ({ mockFetchWithAuth: vi.fn() }));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
}));

import {
  startStreamJoinPollFallback,
  decidePollTickOutcome,
  STREAM_JOIN_POLL_INTERVAL_MS,
} from '../stream-join-poll-fallback';

const okResponse = (streams: unknown[]) => ({
  ok: true,
  json: async () => ({ streams }),
});

const notOkResponse = (status: number) => ({ ok: false, status, json: async () => ({}) });

// The pure decision core for what a failed tick means: an auth failure (401/403) is a signal
// to STOP the 1s interval (the storm) until a refresh lands; anything else is a transient miss
// the interval should ride out and retry on its next tick.
describe('decidePollTickOutcome (pure)', () => {
  it('given a 401, should suspend (an auth failure would otherwise storm the refresh endpoint)', () => {
    expect(decidePollTickOutcome(401)).toBe('suspend');
  });

  it('given a 403, should suspend (same auth-failure class as 401)', () => {
    expect(decidePollTickOutcome(403)).toBe('suspend');
  });

  it('given a 500, should continue (server error — retry on the next tick)', () => {
    expect(decidePollTickOutcome(500)).toBe('continue');
  });

  it('given a 429, should continue (rate limited — retry on the next tick)', () => {
    expect(decidePollTickOutcome(429)).toBe('continue');
  });

  it('given a 400, should continue (not an auth failure)', () => {
    expect(decidePollTickOutcome(400)).toBe('continue');
  });

  it('given a 404, should continue (not an auth failure)', () => {
    expect(decidePollTickOutcome(404)).toBe('continue');
  });
});

describe('startStreamJoinPollFallback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockFetchWithAuth.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('given the signal is already aborted, should never fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    const onSnapshot = vi.fn();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot, vi.fn());
    await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS * 2);

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('should fetch immediately (not wait a full interval) on the first tick', async () => {
    mockFetchWithAuth.mockResolvedValue(okResponse([{ messageId: 'msg-1', parts: [{ type: 'text', text: 'x' }] }]));
    const controller = new AbortController();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      '/api/ai/chat/active-streams?channelId=page-a',
      expect.objectContaining({ credentials: 'include', signal: controller.signal }),
    );
  });

  it('given a matching row, should call onSnapshot with its parts', async () => {
    const parts = [{ type: 'text', text: 'polled content' }];
    mockFetchWithAuth.mockResolvedValue(okResponse([{ messageId: 'msg-1', parts }]));
    const controller = new AbortController();
    const onSnapshot = vi.fn();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot, vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(onSnapshot).toHaveBeenCalledWith(parts);
  });

  // Codex review finding (P2): the row disappearing from active-streams means either the
  // stream finished (dropped out of the status='streaming' filter) or this 404 was never a
  // liveness gap to begin with (e.g. a private conversation this user can't subscribe to —
  // active-streams applies the same subscription filter the join itself did). Either way,
  // polling further can never recover — this must be treated as terminal, not silently ignored.
  describe('row not found (terminal — not a transient miss)', () => {
    it('given a response with no matching messageId, should call onNotFound instead of onSnapshot', async () => {
      mockFetchWithAuth.mockResolvedValue(okResponse([{ messageId: 'some-other-msg', parts: [] }]));
      const controller = new AbortController();
      const onSnapshot = vi.fn();
      const onNotFound = vi.fn();

      startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot, onNotFound);
      await vi.advanceTimersByTimeAsync(0);

      expect(onSnapshot).not.toHaveBeenCalled();
      expect(onNotFound).toHaveBeenCalledTimes(1);
    });

    it('given the row disappears, should stop polling (no leaked interval, no infinite empty ticks)', async () => {
      mockFetchWithAuth.mockResolvedValue(okResponse([]));
      const controller = new AbortController();

      startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn(), vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

      mockFetchWithAuth.mockClear();
      await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS * 5);

      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });

    it('given the row is present on the first tick then disappears on the second, should poll once, then stop and call onNotFound', async () => {
      mockFetchWithAuth
        .mockResolvedValueOnce(okResponse([{ messageId: 'msg-1', parts: [{ type: 'text', text: 'still going' }] }]))
        .mockResolvedValueOnce(okResponse([]));
      const controller = new AbortController();
      const onSnapshot = vi.fn();
      const onNotFound = vi.fn();

      startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot, onNotFound);
      await vi.advanceTimersByTimeAsync(0);
      expect(onSnapshot).toHaveBeenCalledTimes(1);
      expect(onNotFound).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS);
      expect(onNotFound).toHaveBeenCalledTimes(1);

      mockFetchWithAuth.mockClear();
      await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS * 3);
      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });
  });

  // Wire-trust gate — same guard the live SSE path applies (isValidPartFrame).
  it('given malformed parts in the response, should filter them out before calling onSnapshot', async () => {
    mockFetchWithAuth.mockResolvedValue(okResponse([{
      messageId: 'msg-1',
      parts: [
        { type: 'text', text: 'ok' },
        { toolCallId: 'call-1' }, // missing `type`
        { type: 'tool-search', toolName: 'search' }, // tool part missing toolCallId
      ],
    }]));
    const controller = new AbortController();
    const onSnapshot = vi.fn();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot, vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(onSnapshot).toHaveBeenCalledWith([{ type: 'text', text: 'ok' }]);
  });

  it('given a row with no parts field, should call onSnapshot with an empty array', async () => {
    mockFetchWithAuth.mockResolvedValue(okResponse([{ messageId: 'msg-1' }]));
    const controller = new AbortController();
    const onSnapshot = vi.fn();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot, vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(onSnapshot).toHaveBeenCalledWith([]);
  });

  it('should tick again after the poll interval elapses', async () => {
    mockFetchWithAuth.mockResolvedValue(okResponse([{ messageId: 'msg-1', parts: [] }]));
    const controller = new AbortController();
    const onSnapshot = vi.fn();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(3);
  });

  it('given the signal aborts mid-flight, should stop ticking (no leaked interval)', async () => {
    mockFetchWithAuth.mockResolvedValue(okResponse([{ messageId: 'msg-1', parts: [] }]));
    const controller = new AbortController();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    controller.abort();
    mockFetchWithAuth.mockClear();
    await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS * 5);

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  // The abort can land at ANY await point inside an in-flight tick, not just between ticks.
  // Each suspension point re-checks the signal so a snapshot from a tick that outlived its
  // caller (e.g. stream_complete arrived and the DB-reload path already took over) can never
  // clobber the authoritative final content.
  describe('signal aborts mid-tick (at each suspension point)', () => {
    it('given the signal aborts while the fetch is in flight, should discard the resolved response without calling onSnapshot', async () => {
      const controller = new AbortController();
      mockFetchWithAuth.mockImplementation(async () => {
        controller.abort();
        return okResponse([{ messageId: 'msg-1', parts: [{ type: 'text', text: 'stale' }] }]);
      });
      const onSnapshot = vi.fn();
      const onNotFound = vi.fn();

      startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot, onNotFound);
      await vi.advanceTimersByTimeAsync(0);

      expect(onSnapshot).not.toHaveBeenCalled();
      expect(onNotFound).not.toHaveBeenCalled();
    });

    it('given the signal aborts while the body json is being read, should discard the parsed payload without calling onSnapshot or onNotFound', async () => {
      const controller = new AbortController();
      mockFetchWithAuth.mockResolvedValue({
        ok: true,
        json: async () => {
          controller.abort();
          // A payload with NO matching row — if the post-json abort check were missing, this
          // would wrongly fire onNotFound after the caller already moved on.
          return { streams: [] };
        },
      });
      const onSnapshot = vi.fn();
      const onNotFound = vi.fn();

      startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot, onNotFound);
      await vi.advanceTimersByTimeAsync(0);

      expect(onSnapshot).not.toHaveBeenCalled();
      expect(onNotFound).not.toHaveBeenCalled();
    });

    it('given the abort lands before the clearInterval listener is even registered, a later interval tick should return at the entry guard without fetching', async () => {
      const controller = new AbortController();
      // Aborting synchronously INSIDE the first fetch call happens before
      // startStreamJoinPollFallback reaches its own addEventListener('abort') line, so the
      // interval is never cleared by the listener — the per-tick entry guard is the only thing
      // standing between that orphaned interval and a fetch against an aborted signal.
      mockFetchWithAuth.mockImplementation(async () => {
        controller.abort();
        return okResponse([{ messageId: 'msg-1', parts: [] }]);
      });

      startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn(), vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

      mockFetchWithAuth.mockClear();
      await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS * 3);

      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });

    it('given the fetch rejects because the abort landed mid-flight, should stay silent (no retry warning for an intentional stop)', async () => {
      const controller = new AbortController();
      mockFetchWithAuth.mockImplementation(async () => {
        controller.abort();
        throw new Error('socket closed');
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn(), vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // fetch rejects DOMException-style AbortErrors from cancellation paths that don't flip THIS
  // signal (e.g. the auth wrapper's own internal timeout/retry cancellation). Not a failure
  // worth warning about — but also not a reason to stop: the interval keeps polling.
  it('given a tick rejects with an AbortError while the signal is NOT aborted, should stay silent and keep polling on the next interval', async () => {
    mockFetchWithAuth
      .mockRejectedValueOnce(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))
      .mockResolvedValueOnce(okResponse([{ messageId: 'msg-1', parts: [{ type: 'text', text: 'recovered' }] }]));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    const onSnapshot = vi.fn();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(warnSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS);
    expect(onSnapshot).toHaveBeenCalledWith([{ type: 'text', text: 'recovered' }]);
    warnSpy.mockRestore();
  });

  it('given a tick rejects with a non-Error value, should warn and keep polling (not an abort, just a broken tick)', async () => {
    mockFetchWithAuth
      .mockRejectedValueOnce('a rejected string, not an Error instance')
      .mockResolvedValueOnce(okResponse([{ messageId: 'msg-1', parts: [] }]));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it('given a response body with no streams field at all, should treat it as row-gone (terminal) rather than crashing', async () => {
    mockFetchWithAuth.mockResolvedValue({ ok: true, json: async () => ({}) });
    const controller = new AbortController();
    const onNotFound = vi.fn();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn(), onNotFound);
    await vi.advanceTimersByTimeAsync(0);

    expect(onNotFound).toHaveBeenCalledTimes(1);
  });

  it('given a poll tick returns a non-ok response, should not call onSnapshot but should still tick again', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce(okResponse([{ messageId: 'msg-1', parts: [{ type: 'text', text: 'recovered' }] }]));
    const controller = new AbortController();
    const onSnapshot = vi.fn();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(onSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS);
    expect(onSnapshot).toHaveBeenCalledWith([{ type: 'text', text: 'recovered' }]);
  });

  it('given a poll tick throws (network error), should swallow it and tick again on the next interval', async () => {
    mockFetchWithAuth
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(okResponse([{ messageId: 'msg-1', parts: [{ type: 'text', text: 'recovered' }] }]));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = new AbortController();
    const onSnapshot = vi.fn();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(onSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS);
    expect(onSnapshot).toHaveBeenCalledWith([{ type: 'text', text: 'recovered' }]);
    warnSpy.mockRestore();
  });

  it('should encode the channelId and messageId in the request/lookup', async () => {
    mockFetchWithAuth.mockResolvedValue(okResponse([{ messageId: 'msg with space', parts: [] }]));
    const controller = new AbortController();

    startStreamJoinPollFallback('page/weird id', 'msg with space', controller.signal, vi.fn(), vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      `/api/ai/chat/active-streams?channelId=${encodeURIComponent('page/weird id')}`,
      expect.any(Object),
    );
  });

  // The storm (D2): before this, a 401 was swallowed like any other non-ok response and the 1s
  // interval kept firing forever — hammering device-refresh ~1/sec until the rate limit locked
  // the user out. Now a 401/403 SUSPENDS the interval until an `auth:refreshed` event says the
  // session is healed.
  describe('auth-failure suspend/resume (the D2 storm fix)', () => {
    // A suspended poll registers a window `auth:refreshed` listener that only clears on abort or
    // on the event firing. Tests that intentionally leave a poll suspended must abort at the end
    // or their listener leaks onto the shared window and fires during a LATER test's dispatch.
    // Track every controller and abort it in cleanup so each test is isolated.
    const controllers: AbortController[] = [];
    const newController = (): AbortController => {
      const c = new AbortController();
      controllers.push(c);
      return c;
    };
    afterEach(() => {
      controllers.forEach((c) => c.abort());
      controllers.length = 0;
    });

    it('given a 401 tick, should stop the 1s interval — the storm cannot happen', async () => {
      mockFetchWithAuth.mockResolvedValue(notOkResponse(401));
      const controller = newController();

      startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn(), vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

      mockFetchWithAuth.mockClear();
      await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS * 10);
      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });

    it('given a 403 tick, should also stop the interval (same auth-failure class)', async () => {
      mockFetchWithAuth.mockResolvedValue(notOkResponse(403));
      const controller = newController();

      startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn(), vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

      mockFetchWithAuth.mockClear();
      await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS * 10);
      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });

    it('given an auth:refreshed event after a suspend, should resume with an immediate tick and restart the interval', async () => {
      mockFetchWithAuth
        .mockResolvedValueOnce(notOkResponse(401)) // first tick suspends
        .mockResolvedValue(okResponse([{ messageId: 'msg-1', parts: [{ type: 'text', text: 'healed' }] }]));
      const controller = newController();
      const onSnapshot = vi.fn();

      startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot, vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

      // Refresh landed — the session is healed. Resuming fires an IMMEDIATE tick (not a full
      // interval's wait).
      window.dispatchEvent(new Event('auth:refreshed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);
      expect(onSnapshot).toHaveBeenCalledWith([{ type: 'text', text: 'healed' }]);

      // ...and the interval is running again.
      await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS);
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(3);
    });

    it('given the signal aborts while suspended, should remove the auth:refreshed listener (no leak, no resume)', async () => {
      mockFetchWithAuth.mockResolvedValue(notOkResponse(401));
      const controller = newController();

      startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn(), vi.fn());
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

      controller.abort();
      mockFetchWithAuth.mockClear();

      // The listener must be gone — a stray auth:refreshed cannot resurrect a dead poll.
      window.dispatchEvent(new Event('auth:refreshed'));
      await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS * 5);
      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });

    it('given auth:refreshed fires but the signal aborted first, should not resume', async () => {
      // Belt-and-suspenders: even if the listener somehow survived the abort cleanup, the resume
      // handler itself must no-op on an aborted signal.
      mockFetchWithAuth.mockResolvedValue(notOkResponse(401));
      const controller = newController();

      startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn(), vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      controller.abort();
      mockFetchWithAuth.mockClear();
      window.dispatchEvent(new Event('auth:refreshed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchWithAuth).not.toHaveBeenCalled();
    });

    it('given a second 401 after a resume, should suspend again (survives repeated auth failures)', async () => {
      mockFetchWithAuth
        .mockResolvedValueOnce(notOkResponse(401)) // tick 1 → suspend
        .mockResolvedValueOnce(notOkResponse(401)); // resumed tick → suspend again
      const controller = newController();

      startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn(), vi.fn());
      await vi.advanceTimersByTimeAsync(0);

      window.dispatchEvent(new Event('auth:refreshed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(2);

      // Suspended again — interval is stopped, no storm.
      mockFetchWithAuth.mockClear();
      await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS * 5);
      expect(mockFetchWithAuth).not.toHaveBeenCalled();

      // A fresh auth:refreshed still resumes it.
      mockFetchWithAuth.mockResolvedValue(okResponse([{ messageId: 'msg-1', parts: [] }]));
      window.dispatchEvent(new Event('auth:refreshed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);
    });
  });
});

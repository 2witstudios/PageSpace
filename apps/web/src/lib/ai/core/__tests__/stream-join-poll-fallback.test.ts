import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockFetchWithAuth } = vi.hoisted(() => ({ mockFetchWithAuth: vi.fn() }));

vi.mock('@/lib/auth/auth-fetch', () => ({
  fetchWithAuth: mockFetchWithAuth,
}));

import { startStreamJoinPollFallback, STREAM_JOIN_POLL_INTERVAL_MS } from '../stream-join-poll-fallback';

const okResponse = (streams: unknown[]) => ({
  ok: true,
  json: async () => ({ streams }),
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

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot);
    await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS * 2);

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it('should fetch immediately (not wait a full interval) on the first tick', async () => {
    mockFetchWithAuth.mockResolvedValue(okResponse([{ messageId: 'msg-1', parts: [{ type: 'text', text: 'x' }] }]));
    const controller = new AbortController();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn());
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

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot);
    await vi.advanceTimersByTimeAsync(0);

    expect(onSnapshot).toHaveBeenCalledWith(parts);
  });

  it('given a response with no matching messageId, should not call onSnapshot', async () => {
    mockFetchWithAuth.mockResolvedValue(okResponse([{ messageId: 'some-other-msg', parts: [] }]));
    const controller = new AbortController();
    const onSnapshot = vi.fn();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot);
    await vi.advanceTimersByTimeAsync(0);

    expect(onSnapshot).not.toHaveBeenCalled();
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

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot);
    await vi.advanceTimersByTimeAsync(0);

    expect(onSnapshot).toHaveBeenCalledWith([{ type: 'text', text: 'ok' }]);
  });

  it('given a row with no parts field, should call onSnapshot with an empty array', async () => {
    mockFetchWithAuth.mockResolvedValue(okResponse([{ messageId: 'msg-1' }]));
    const controller = new AbortController();
    const onSnapshot = vi.fn();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot);
    await vi.advanceTimersByTimeAsync(0);

    expect(onSnapshot).toHaveBeenCalledWith([]);
  });

  it('should tick again after the poll interval elapses', async () => {
    mockFetchWithAuth.mockResolvedValue(okResponse([{ messageId: 'msg-1', parts: [] }]));
    const controller = new AbortController();
    const onSnapshot = vi.fn();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot);
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

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(mockFetchWithAuth).toHaveBeenCalledTimes(1);

    controller.abort();
    mockFetchWithAuth.mockClear();
    await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS * 5);

    expect(mockFetchWithAuth).not.toHaveBeenCalled();
  });

  it('given a poll tick returns a non-ok response, should not call onSnapshot but should still tick again', async () => {
    mockFetchWithAuth
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce(okResponse([{ messageId: 'msg-1', parts: [{ type: 'text', text: 'recovered' }] }]));
    const controller = new AbortController();
    const onSnapshot = vi.fn();

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot);
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

    startStreamJoinPollFallback('page-a', 'msg-1', controller.signal, onSnapshot);
    await vi.advanceTimersByTimeAsync(0);
    expect(onSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STREAM_JOIN_POLL_INTERVAL_MS);
    expect(onSnapshot).toHaveBeenCalledWith([{ type: 'text', text: 'recovered' }]);
    warnSpy.mockRestore();
  });

  it('should encode the channelId and messageId in the request/lookup', async () => {
    mockFetchWithAuth.mockResolvedValue(okResponse([{ messageId: 'msg with space', parts: [] }]));
    const controller = new AbortController();

    startStreamJoinPollFallback('page/weird id', 'msg with space', controller.signal, vi.fn());
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetchWithAuth).toHaveBeenCalledWith(
      `/api/ai/chat/active-streams?channelId=${encodeURIComponent('page/weird id')}`,
      expect.any(Object),
    );
  });
});

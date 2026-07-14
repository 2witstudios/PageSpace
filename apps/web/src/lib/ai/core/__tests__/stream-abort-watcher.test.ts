import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { assert } from './riteway';

const {
  mockListLocalStreams,
  mockAbortStream,
  mockReadMarkedStreams,
  mockClearAbortMarks,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockListLocalStreams: vi.fn(),
  mockAbortStream: vi.fn(),
  mockReadMarkedStreams: vi.fn(),
  mockClearAbortMarks: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock('../stream-abort-registry', () => ({
  listLocalStreams: mockListLocalStreams,
  abortStream: mockAbortStream,
}));

vi.mock('../stream-abort-mark', () => ({
  readMarkedStreams: mockReadMarkedStreams,
  clearAbortMarks: mockClearAbortMarks,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: vi.fn(), error: mockLoggerError, debug: vi.fn() } },
}));

import {
  runAbortWatchTick,
  ensureStreamAbortWatcher,
  stopStreamAbortWatcher,
  isStreamAbortWatcherRunning,
  ABORT_WATCH_INTERVAL_MS,
} from '../stream-abort-watcher';

beforeEach(() => {
  vi.clearAllMocks();
  mockListLocalStreams.mockReturnValue([]);
  mockReadMarkedStreams.mockResolvedValue([]);
  mockAbortStream.mockReturnValue({ aborted: true, reason: 'Stream aborted by user request' });
  stopStreamAbortWatcher();
});

afterEach(() => {
  stopStreamAbortWatcher();
});

describe('runAbortWatchTick', () => {
  // The whole point of the change: a Stop issued on another instance reaches the instance that
  // actually holds the AbortController, and stops the generation.
  it('aborts a locally-owned stream that another instance marked', async () => {
    mockListLocalStreams.mockReturnValue([
      { messageId: 'msg-1', streamId: 'stream-1', userId: 'user-a' },
    ]);
    mockReadMarkedStreams.mockResolvedValue([
      { messageId: 'msg-1', streamId: 'stream-1', userId: 'user-a' },
    ]);

    await runAbortWatchTick();

    assert({
      given: 'an abort request marked on a stream this instance owns',
      should: 'abort it locally, as the owner named by our own DB row',
      actual: mockAbortStream.mock.calls[0]?.[0],
      expected: { streamId: 'stream-1', userId: 'user-a' },
    });
  });

  // A mark on someone else's stream is none of our business — and must NOT be cleared. Clearing it
  // would consume the abort request without performing the abort, so the instance that could
  // actually stop the stream would never see it. The user's Stop would silently do nothing: the
  // exact bug this whole change exists to fix, reintroduced from the other end.
  it('leaves a mark for another instance alone, and never clears it', async () => {
    mockListLocalStreams.mockReturnValue([
      { messageId: 'msg-mine', streamId: 'stream-mine', userId: 'user-a' },
    ]);
    mockReadMarkedStreams.mockResolvedValue([
      { messageId: 'msg-theirs', streamId: 'stream-theirs', userId: 'user-b' },
    ]);

    await runAbortWatchTick();

    expect(mockAbortStream).not.toHaveBeenCalled();
    assert({
      given: 'a marked stream owned by a different web instance',
      should: 'not consume the mark — its owner has not read it yet',
      actual: mockClearAbortMarks.mock.calls.length,
      expected: 0,
    });
  });

  // Corruption, not a normal condition. If the row and the registry disagree about who owns a
  // stream, aborting would stop the WRONG USER's generation.
  it('refuses to abort when the row owner disagrees with the local stream owner', async () => {
    mockListLocalStreams.mockReturnValue([
      { messageId: 'msg-1', streamId: 'stream-1', userId: 'user-a' },
    ]);
    mockReadMarkedStreams.mockResolvedValue([
      { messageId: 'msg-1', streamId: 'stream-1', userId: 'user-b' },
    ]);

    await runAbortWatchTick();

    expect(mockAbortStream).not.toHaveBeenCalled();
    assert({
      given: 'a marked row whose owner is not the owner we have registered',
      should: 'raise it as an error rather than aborting the wrong stream',
      actual: mockLoggerError.mock.calls.length,
      expected: 1,
    });
  });

  it('clears a mark left over from a superseded generation', async () => {
    mockListLocalStreams.mockReturnValue([
      { messageId: 'msg-1', streamId: 'stream-2', userId: 'user-a' },
    ]);
    mockReadMarkedStreams.mockResolvedValue([
      { messageId: 'msg-1', streamId: 'stream-1', userId: 'user-a' },
    ]);

    await runAbortWatchTick();

    expect(mockAbortStream).not.toHaveBeenCalled();
    assert({
      given: 'a mark naming a previous generation on a reused messageId',
      should: 'clear it rather than kill the current generation or re-read it forever',
      actual: mockClearAbortMarks.mock.calls[0]?.[0],
      expected: { messageIds: ['msg-1'] },
    });
  });

  it('does not query at all when this instance owns no streams', async () => {
    mockListLocalStreams.mockReturnValue([]);

    await runAbortWatchTick();

    assert({
      given: 'an instance with no in-flight streams',
      should: 'never touch the database',
      actual: mockReadMarkedStreams.mock.calls.length,
      expected: 0,
    });
  });

  // The mark is durable, which is the entire reason a poll was chosen over a broadcast: a tick
  // that fails changes nothing, because the next tick reads the same mark again.
  it('survives a failing tick without throwing', async () => {
    mockListLocalStreams.mockReturnValue([
      { messageId: 'msg-1', streamId: 'stream-1', userId: 'user-a' },
    ]);
    mockReadMarkedStreams.mockRejectedValue(new Error('db down'));

    await expect(runAbortWatchTick()).resolves.toBeUndefined();
  });
});

describe('the watcher interval', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('polls while this instance owns a stream', async () => {
    mockListLocalStreams.mockReturnValue([
      { messageId: 'msg-1', streamId: 'stream-1', userId: 'user-a' },
    ]);

    ensureStreamAbortWatcher();
    await vi.advanceTimersByTimeAsync(ABORT_WATCH_INTERVAL_MS * 2);

    expect(mockReadMarkedStreams.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('starts only one interval however many streams start', () => {
    ensureStreamAbortWatcher();
    ensureStreamAbortWatcher();
    ensureStreamAbortWatcher();

    assert({
      given: 'several streams starting on one instance',
      should: 'run a single shared poll, not one per stream',
      actual: vi.getTimerCount(),
      expected: 1,
    });
  });

  // An idle instance must cost nothing. The interval is started lazily by the first stream, so it
  // has to shut itself down when the last one ends — otherwise every instance that ever generated
  // once would poll the database forever.
  it('stops itself once the instance owns no more streams', async () => {
    mockListLocalStreams.mockReturnValue([
      { messageId: 'msg-1', streamId: 'stream-1', userId: 'user-a' },
    ]);
    ensureStreamAbortWatcher();
    await vi.advanceTimersByTimeAsync(ABORT_WATCH_INTERVAL_MS);

    mockListLocalStreams.mockReturnValue([]);
    await vi.advanceTimersByTimeAsync(ABORT_WATCH_INTERVAL_MS);

    assert({
      given: 'the last in-flight stream on this instance finishing',
      should: 'shut the poll down rather than query an empty set forever',
      actual: isStreamAbortWatcherRunning(),
      expected: false,
    });
  });
});

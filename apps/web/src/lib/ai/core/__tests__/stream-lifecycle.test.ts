import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  mockBroadcastStart,
  mockBroadcastComplete,
  mockInsertValues,
  mockInsertOnConflict,
  mockUpdateSet,
  mockUpdateWhere,
  mockLoggerWarn,
  mockConsumePendingAbort,
  mockEnsureWatcher,
  mockStartFrameLogWriter,
  mockFrameWriterClose,
  mockFrameWriterRelease,
  mockReleaseFrames,
  aiStreamSessionsToken,
} = vi.hoisted(() => ({
  mockBroadcastStart: vi.fn().mockResolvedValue(undefined),
  mockBroadcastComplete: vi.fn().mockResolvedValue(undefined),
  mockInsertValues: vi.fn(),
  mockInsertOnConflict: vi.fn().mockResolvedValue(undefined),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn().mockResolvedValue(undefined),
  mockLoggerWarn: vi.fn(),
  mockConsumePendingAbort: vi.fn().mockResolvedValue(false),
  mockEnsureWatcher: vi.fn(),
  mockStartFrameLogWriter: vi.fn(),
  mockFrameWriterClose: vi.fn(),
  mockFrameWriterRelease: vi.fn(),
  mockReleaseFrames: vi.fn(),
  aiStreamSessionsToken: { __table: 'ai_stream_sessions', messageId: 'message_id' },
}));

/**
 * The channel registry is NOT mocked, deliberately.
 *
 * It is pure in-memory with no I/O, so the real thing makes these assertions about captured
 * frames rather than about "did we call the collaborator". The suite this replaces mocked
 * `streamMulticastRegistry` and then asserted on the mock — which is why a whole class of
 * behaviour (what actually ends up in the snapshot) was never covered.
 */
vi.mock('@/lib/websocket', () => ({
  broadcastAiStreamStart: mockBroadcastStart,
  broadcastAiStreamComplete: mockBroadcastComplete,
}));

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: (row: Record<string, unknown>) => {
        mockInsertValues(row);
        return {
          onConflictDoUpdate: (cfg: Record<string, unknown>) => mockInsertOnConflict(cfg),
        };
      },
    })),
    update: vi.fn(() => ({
      set: (patch: Record<string, unknown>) => {
        mockUpdateSet(patch);
        return {
          where: (clause: unknown) => mockUpdateWhere(clause),
        };
      },
    })),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((col, val) => ({ col, val })),
}));

vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamSessions: aiStreamSessionsToken,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    ai: {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      warn: mockLoggerWarn,
    },
  },
}));

vi.mock('@/lib/ai/core/stream-horizons', () => ({
  STREAM_MAX_LIFETIME_MS: 60 * 60 * 1000,
}));

vi.mock('@/lib/ai/core/stream-abort-watcher', () => ({
  ensureStreamAbortWatcher: mockEnsureWatcher,
}));

vi.mock('@/lib/ai/core/pending-abort-intents', () => ({
  consumePendingAbort: mockConsumePendingAbort,
}));

/**
 * The durable frame log's writer is mocked here, and only here.
 *
 * It has its own suite (`frame-log-writer.test.ts`) built on a real channel, where the
 * batching cadence and the failure paths are the subject. What this file needs to know is
 * narrower: that the lifecycle STARTS one for the generation, hands it the channel every
 * other subscriber shares, and ends it — and, crucially, that the parts checkpoint's
 * behaviour below is the lifecycle's own and not the writer's.
 */
vi.mock('@/lib/ai/core/frame-log-writer', () => ({
  startFrameLogWriter: mockStartFrameLogWriter,
  releaseFramesForMessage: mockReleaseFrames,
}));

import type { UIMessageChunk } from 'ai';
import { streamChannelRegistry } from '../stream-channel-registry';
import { createStreamLifecycle as createStreamLifecycleUntracked } from '../stream-lifecycle';
import { CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS } from '../checkpoint-scheduler';

// The 1s checkpoint interval (unlike the old 20s-only heartbeat) is short enough to reliably
// fire mid-suite on REAL timers if a test never calls finish() — polluting whichever later
// test happens to be running when it lands. Track every handle so a single top-level
// afterEach can finish() them all, real timers or fake, regardless of what each test does.
let activeLifecycles: Array<{ finish: (aborted: boolean) => void }> = [];
const createStreamLifecycle: typeof createStreamLifecycleUntracked = async (p) => {
  const handle = await createStreamLifecycleUntracked(p);
  activeLifecycles.push(handle);
  return handle;
};

const params = (overrides: Partial<Parameters<typeof createStreamLifecycle>[0]> = {}) => ({
  messageId: 'msg-1',
  channelId: 'page-1',
  conversationId: 'conv-1',
  userId: 'user-1',
  displayName: 'Alice',
  browserSessionId: 'session-1',
  streamId: 'stream-1',
  ...overrides,
});

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

const chunk = (value: unknown): UIMessageChunk => value as UIMessageChunk;

/**
 * A text part arrives as three frames. The fold needs the `text-start` before any delta —
 * an orphaned delta is skipped — so tests that want visible text must open the part first.
 */
const textStart = chunk({ type: 'text-start', id: 't1' });
const textDelta = (delta = 'hello') => chunk({ type: 'text-delta', id: 't1', delta });

/** A durability boundary: bypasses the dirty-flush throttle. See isDurabilityBoundary. */
const toolBoundary = chunk({
  type: 'tool-input-available',
  toolCallId: 'tc1',
  toolName: 'list_pages',
  input: { driveId: 'd1' },
});

/** Open a text part and write `text` into it, as the pump would. */
const writeText = (handle: { channel: { append: (c: UIMessageChunk) => void } }, text = 'hello') => {
  handle.channel.append(textStart);
  handle.channel.append(textDelta(text));
};

/**
 * Shared reset. Three top-level describes need it, and a describe's own beforeEach does not
 * reach its siblings — the frame-log-writer assertions below are call-count assertions, so a
 * missed reset makes them read another test's calls.
 */
const resetStreamLifecycleMocks = () => {
  vi.clearAllMocks();
  mockConsumePendingAbort.mockResolvedValue(false);
  mockEnsureWatcher.mockImplementation(() => {});
  mockFrameWriterClose.mockResolvedValue(undefined);
  mockFrameWriterRelease.mockResolvedValue(undefined);
  mockStartFrameLogWriter.mockImplementation(() => ({
    close: mockFrameWriterClose,
    abandon: vi.fn().mockResolvedValue(undefined),
    // The lifecycle releases through its OWN writer, so a superseded lifecycle cannot delete
    // a successor's log. `releaseFramesForMessage` (by name) is only the pre-abort path.
    release: mockFrameWriterRelease,
  }));
  mockReleaseFrames.mockResolvedValue(undefined);
  // The registry is module-global state, not a mock, so it leaks across tests unless reset.
  // Same hazard the old mockReturnValue leak had, different mechanism.
  streamChannelRegistry.reset();
  mockInsertOnConflict.mockResolvedValue(undefined);
  mockUpdateWhere.mockResolvedValue(undefined);
  mockBroadcastStart.mockResolvedValue(undefined);
  mockBroadcastComplete.mockResolvedValue(undefined);
};

/** Finish every lifecycle a test created, so no interval survives into the next one. */
const finishTrackedLifecycles = () => {
  for (const handle of activeLifecycles) {
    try {
      handle.finish(true);
    } catch {
      // best-effort cleanup only — a throw here must not fail an unrelated test
    }
  }
  activeLifecycles = [];
};

describe('createStreamLifecycle', () => {
  beforeEach(resetStreamLifecycleMocks);
  afterEach(finishTrackedLifecycles);

  describe('register / insert / broadcastStart on creation', () => {
    it('given valid params, should open a channel for the messageId carrying full stream meta', async () => {
      await createStreamLifecycle(params());

      expect(streamChannelRegistry.getMeta('msg-1')).toEqual({
        pageId: 'page-1',
        userId: 'user-1',
        displayName: 'Alice',
        conversationId: 'conv-1',
        browserSessionId: 'session-1',
      });
    });

    it('given valid params, should insert an aiStreamSessions row with status=streaming and full identity fields', async () => {
      await createStreamLifecycle(params());

      expect(mockInsertValues).toHaveBeenCalledWith({
        messageId: 'msg-1',
        channelId: 'page-1',
        conversationId: 'conv-1',
        userId: 'user-1',
        displayName: 'Alice',
        browserSessionId: 'session-1',
        streamId: 'stream-1',
        status: 'streaming',
        startedAt: expect.any(Date),
        lastHeartbeatAt: expect.any(Date),
      });
    });

    // The streamId is the name the client is handed in `X-Stream-Id`, and the ONLY reason a Stop
    // that lands on another web instance can resolve which stream it means — the registry that
    // mints it is in-process. Drop it here and every fresh row has stream_id = NULL: the mark
    // matches zero rows, the endpoint reports `not_found`, the client stays SILENT by design, and
    // the generation runs on and bills. The headline feature, dead, with nothing to show for it.
    it('given a streamId, should persist it on the row so any instance can resolve the stream', async () => {
      await createStreamLifecycle({ ...params(), streamId: 'stream-1' });

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ streamId: 'stream-1' }),
      );
    });

    it('given a REUSED row, should record the streamId it now belongs to', async () => {
      await createStreamLifecycle({ ...params(), streamId: 'stream-2' });

      expect(mockInsertOnConflict.mock.calls[0][0].set).toMatchObject({ streamId: 'stream-2' });
    });

    // An abort request aimed at the PREVIOUS generation on this messageId must not be inherited by
    // this one, or the abort watcher kills the fresh stream within a second of it starting — a
    // generation cancelled by a Stop the user pressed on something else entirely. No error, no
    // log; it would simply look like the model gave up.
    it('given a REUSED row, should clear any abort request left over from the previous generation', async () => {
      await createStreamLifecycle({ ...params(), streamId: 'stream-2' });

      expect(mockInsertOnConflict.mock.calls[0][0].set).toMatchObject({ abortRequestedAt: null });
    });

    it('given a duplicate messageId, should refresh all fields via onConflictDoUpdate, including resetting parts to empty', async () => {
      await createStreamLifecycle(params());

      expect(mockInsertOnConflict).toHaveBeenCalledTimes(1);
      const cfg = mockInsertOnConflict.mock.calls[0][0];
      expect(cfg.set).toMatchObject({
        channelId: 'page-1',
        conversationId: 'conv-1',
        userId: 'user-1',
        displayName: 'Alice',
        browserSessionId: 'session-1',
        status: 'streaming',
        completedAt: null,
        // A re-registered messageId gets a fresh in-memory buffer (registry.register
        // evicts any prior entry) — the DB snapshot must reset with it, or a bootstrap
        // racing the re-registration would serve the prior attempt's stale parts as
        // if they were a prefix of the new attempt's live buffer.
        parts: [],
        // Resets alongside parts — a stale count from the previous attempt would make a
        // rejoining client under-skip on its live replay.
        rawPartsCount: 0,
      });
      expect(cfg.set.startedAt).toBeInstanceOf(Date);
    });

    it('given the insert is in-flight, should not broadcast chat:stream_start until it has resolved', async () => {
      let resolveInsert!: () => void;
      mockInsertOnConflict.mockImplementationOnce(
        () => new Promise<void>((res) => { resolveInsert = res; })
      );

      const lifecyclePromise = createStreamLifecycle(params());
      await flushMicrotasks();

      expect(mockInsertValues).toHaveBeenCalled();
      expect(mockBroadcastStart).not.toHaveBeenCalled();

      resolveInsert();
      await lifecyclePromise;

      expect(mockBroadcastStart).toHaveBeenCalled();
    });

    it('given a successful start, should broadcast chat:stream_start with the full triggeredBy payload and start time', async () => {
      await createStreamLifecycle(params());

      expect(mockBroadcastStart).toHaveBeenCalledWith({
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
        startedAt: expect.any(String),
        // Rides the broadcast so page members can tell a stream they may watch from a
        // co-member's PRIVATE conversation, without firing a doomed join at the server.
        isShared: false,
        triggeredBy: { userId: 'user-1', displayName: 'Alice', browserSessionId: 'session-1' },
      });
    });

    it('given the insert rejects, should warn and still resolve the lifecycle handle', async () => {
      mockInsertOnConflict.mockRejectedValueOnce(new Error('db down'));

      const handle = await createStreamLifecycle(params());

      expect(mockLoggerWarn).toHaveBeenCalled();
      expect(handle).toBeDefined();
    });

    it('given broadcastStart rejects, should not throw out of the factory', async () => {
      mockBroadcastStart.mockRejectedValueOnce(new Error('socket dead'));

      await expect(createStreamLifecycle(params())).resolves.toBeDefined();
    });
  });

  describe('channel — the handle exposes one object the pump and every joiner share', () => {
    it('given a frame appended, should be captured on the channel under this messageId', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.channel.append(textStart);

      expect(lifecycle.channel.getFrames()).toEqual([textStart]);
      expect(streamChannelRegistry.get('msg-1')).toBe(lifecycle.channel);
    });

    it('given finish() already ran, should refuse further frames rather than accept and drop them', async () => {
      // The pre-inversion handle exposed `pushPart`, which silently no-op'd after finish.
      // A finished channel REFUSES, so a caller still pumping is observable instead of
      // quietly losing a generation.
      const lifecycle = await createStreamLifecycle(params());
      lifecycle.finish(false);

      lifecycle.channel.append(textStart);

      expect(lifecycle.channel.getFrames()).toEqual([]);
      expect(lifecycle.channel.finished).toBe(true);
    });

    it('given finish() already ran, should not count toward the checkpoint (would otherwise race the final write with an empty snapshot)', async () => {
      const lifecycle = await createStreamLifecycle(params());
      lifecycle.finish(false);
      mockUpdateSet.mockClear();

      for (let i = 0; i < 25; i++) lifecycle.channel.append(textDelta());
      await flushMicrotasks();

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });
  });

  describe('checkpoint cadence — time-based, with a durability-boundary bypass', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      // Tests that don't call finish() leave the heartbeat and checkpoint intervals armed —
      // clear them explicitly, or a leftover setInterval fires during a later test's
      // fake-timer advance and pollutes its assertions.
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    /** The folded snapshot the checkpoint is expected to write for a single 'hello' text part. */
    const helloSnapshot = [
      { type: 'text', text: 'hello', state: 'streaming', providerMetadata: undefined },
    ];

    it('given a frame right after start, should not persist immediately (throttled to the dirty-flush window)', async () => {
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      writeText(lifecycle);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it('given a dirty buffer and at least 1s elapsed since the last checkpoint, should persist the folded snapshot on the next frame', async () => {
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      writeText(lifecycle);
      // The clock is moved WITHOUT running timers on purpose. Advancing by the interval would
      // fire the interval's own flush, and then this test would be pinning that path instead —
      // which the "no further frames" case already covers. Here the frame must do it.
      vi.setSystemTime(Date.now() + CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS);
      lifecycle.channel.append(textDelta(''));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
      expect(mockUpdateSet).toHaveBeenCalledWith({
        parts: helloSnapshot,
        rawPartsCount: 3,
        // Not expect.any(Date): the checkpoint stamps this AFTER awaiting the fold, and under
        // fake timers the value is a ClockDate rather than a Date instance.
        lastHeartbeatAt: expect.anything(),
      });
    });

    it('given a tool-boundary frame, should persist immediately even inside the 1s throttle window', async () => {
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      lifecycle.channel.append(toolBoundary);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
      expect(mockUpdateSet).toHaveBeenCalledWith({
        parts: [expect.objectContaining({ type: 'tool-list_pages', state: 'input-available' })],
        rawPartsCount: 1,
        lastHeartbeatAt: expect.anything(),
      });
    });

    it('given a reasoning frame, should NOT bypass the throttle (it streams token-by-token like text)', async () => {
      // The bypass is an explicit allow-list rather than "anything that is not a text delta".
      // A negative check would fire on every frame of a long chain-of-thought and turn the
      // checkpoint back into a per-token write.
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      lifecycle.channel.append(chunk({ type: 'reasoning-start', id: 'r1' }));
      lifecycle.channel.append(chunk({ type: 'reasoning-delta', id: 'r1', delta: 'thinking' }));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it('given tool-input-delta frames, should NOT bypass the throttle — they stream token-by-token too', async () => {
      // `tool-input-delta` carries the model's tool ARGUMENTS one token at a time, so it is a
      // text delta wearing the tool family's prefix. A `startsWith('tool-')` bypass made every
      // one of them a boundary and rewrote the whole parts array per token for the length of
      // the argument stream. `persistInFlight` serializes those writes; it does not throttle
      // them (review finding — coderabbitai, PR #2408).
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      lifecycle.channel.append(chunk({
        type: 'tool-input-start', toolCallId: 'tc9', toolName: 'create_page',
      }));
      await vi.advanceTimersByTimeAsync(0);
      // The START is a boundary — a rejoining client must see the call began.
      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
      mockUpdateSet.mockClear();

      for (const inputTextDelta of ['{"tit', 'le":"', 'Hello', '"}']) {
        lifecycle.channel.append(chunk({ type: 'tool-input-delta', toolCallId: 'tc9', inputTextDelta }));
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(
        mockUpdateSet,
        'every argument token forced its own checkpoint write',
      ).not.toHaveBeenCalled();
    });

    it('given a tool-boundary flush just landed, should still throttle the very next text frame for 1s', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.channel.append(toolBoundary);
      await vi.advanceTimersByTimeAsync(0);
      mockUpdateSet.mockClear();

      writeText(lifecycle);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    // The whole reason for a dedicated interval, independent of the frame flow: a stream sitting
    // in a long tool call emits one frame (tool-input-available) and then nothing for minutes —
    // a rejoining client should still see that the tool started, not a snapshot frozen from
    // before the call began.
    it('given a dirty buffer and no further frames, the unref\'d 1s interval should flush it mid-tool-call', async () => {
      const lifecycle = await createStreamLifecycle(params());
      writeText(lifecycle);
      mockUpdateSet.mockClear();

      await vi.advanceTimersByTimeAsync(CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS);

      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    });

    it('given no frames at all, the 1s interval should never persist (nothing dirty to flush)', async () => {
      await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      await vi.advanceTimersByTimeAsync(CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS * 3);

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it('given the checkpoint persist rejects, should warn and not throw', async () => {
      mockUpdateWhere.mockRejectedValueOnce(new Error('db down'));
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.channel.append(toolBoundary);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'stream-lifecycle: aiStreamSessions parts persist failed',
        expect.objectContaining({ messageId: 'msg-1' }),
      );
    });

    it('given a persist is still in flight, should skip scheduling another until it settles', async () => {
      let release: (() => void) | undefined;
      mockUpdateWhere.mockImplementationOnce(
        () => new Promise<void>((resolve) => { release = resolve; }),
      );
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.channel.append(toolBoundary);
      await vi.advanceTimersByTimeAsync(0);
      mockUpdateSet.mockClear();

      lifecycle.channel.append(chunk({ type: 'tool-output-available', toolCallId: 'tc1', output: {} }));
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateSet).not.toHaveBeenCalled();
      release?.();
    });

    it('given consecutive text-delta frames before a checkpoint, should fold them into one text part on the persisted snapshot', async () => {
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      lifecycle.channel.append(textStart);
      lifecycle.channel.append(textDelta('one '));
      lifecycle.channel.append(textDelta('two '));
      lifecycle.channel.append(textDelta('three'));
      lifecycle.channel.append(toolBoundary);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({
          parts: [
            { type: 'text', text: 'one two three', state: 'streaming', providerMetadata: undefined },
            expect.objectContaining({ type: 'tool-list_pages' }),
          ],
        }),
      );
    });

    it('given reasoning, a file and a source frame, should persist them — the projection this replaces dropped all three', async () => {
      // The headline fidelity gain, asserted directly. `chunkToPart` forwarded four chunk
      // types; everything here was silently absent from the snapshot, from every re-attach,
      // and from the durable save whenever onFinish never ran.
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      lifecycle.channel.append(chunk({ type: 'reasoning-start', id: 'r1' }));
      lifecycle.channel.append(chunk({ type: 'reasoning-delta', id: 'r1', delta: 'because' }));
      lifecycle.channel.append(chunk({ type: 'reasoning-end', id: 'r1' }));
      lifecycle.channel.append(chunk({ type: 'file', mediaType: 'image/png', url: 'https://x.test/a.png' }));
      lifecycle.channel.append(chunk({ type: 'source-url', sourceId: 's1', url: 'https://x.test/d', title: 'D' }));
      lifecycle.channel.append(chunk({ type: 'data-commandExecution', id: 'm1-command-0', data: { command: 'plan' } }));
      // The first boundary flushes immediately; the rest are skipped while that write is in
      // flight. Advance past the throttle so the interval flushes the complete snapshot.
      await vi.advanceTimersByTimeAsync(CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS * 2);

      const persisted = mockUpdateSet.mock.calls.at(-1)?.[0] as { parts: { type: string }[] };
      expect(persisted.parts.map((part) => part.type)).toEqual([
        'reasoning',
        'file',
        'source-url',
        'data-commandExecution',
      ]);
    });
  });

  describe('heartbeat — an independent timer, not the parts checkpoint', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      // Tests that don't call finish() leave the heartbeat and checkpoint intervals armed —
      // clear them explicitly, or a leftover setInterval fires (with THIS test's stale mock
      // return values) during a later test's fake-timer advance and pollutes its assertions.
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    it('given a stream that pushes NO parts at all (a long tool call), should still beat', async () => {
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockUpdateSet).toHaveBeenCalled();
      // Heartbeat-only: it must never touch `parts`, or it could race the checkpoint writes.
      // Nothing was ever pushed, so the checkpoint interval has nothing dirty to flush either.
      for (const call of mockUpdateSet.mock.calls) {
        expect(call[0]).toEqual({ lastHeartbeatAt: expect.any(Date) });
      }

      lifecycle.finish(false);
    });

    // Backstop. finish() clears the interval and every generation path reaches it — but
    // an UNBOUNDED heartbeat on a lifecycle that somehow never finished would be strictly
    // worse than no heartbeat: the row would look live forever, so it could never be
    // reconciled and never be taken over (the abort registry drops its entry after 10
    // min), and would be served to clients as an unjoinable phantom stream for the life
    // of the process. Capping the beat turns that immortal ghost back into an ordinary
    // stale row.
    // The 1s checkpoint interval means simulating ~2h of fake time here fires thousands of
    // timer callbacks (vs. hundreds for the 20s heartbeat alone) — genuinely more real work
    // for vi.advanceTimersByTimeAsync to process, hence the longer wall-clock timeout.
    it('given a lifecycle that never finishes, should stop beating after the cap rather than looking live forever', async () => {
      await createStreamLifecycle(params());

      // Still beating well inside the cap — a long-but-plausible generation must never be
      // cut off, or the next send would drive its LIVE row terminal.
      await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
      expect(mockUpdateSet).toHaveBeenCalled();

      // Past the cap: both the heartbeat interval and the checkpoint interval must have
      // cancelled themselves.
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      mockUpdateSet.mockClear();

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(mockUpdateSet).not.toHaveBeenCalled();
    }, 20_000);

    // THE HOLE THE CAP DID NOT ACTUALLY CLOSE.
    //
    // Capping the interval beat is useless on its own, because a parts checkpoint ALSO writes
    // lastHeartbeatAt — and the parts checkpoint used to run with no deadline at all. So the one
    // generation most likely to outlive the cap (a long one, still chattering) kept refreshing
    // its own liveness FOREVER, which is precisely the immortal ghost the cap exists to kill. And
    // it is the worst possible ghost: by then BOTH registries have evicted it, so /active-streams
    // advertises a live, joinable stream that no client can join and whose Stop button is a
    // silent no-op, while the generation keeps running its tools and keeps billing.
    it('given a stream still pushing parts past the horizon, should stop refreshing its heartbeat rather than look live forever', async () => {
      const lifecycle = await createStreamLifecycle(params());

      // Past the horizon, but still generating hard. The 1s checkpoint interval makes this
      // ~61 minutes of fake time genuinely more timer-callback work than the 20s heartbeat
      // alone used to be, hence the longer wall-clock timeout below.
      await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
      mockUpdateSet.mockClear();

      for (let i = 0; i < 60; i++) lifecycle.channel.append(toolBoundary);
      await vi.advanceTimersByTimeAsync(0);

      // Not one write. The row is allowed to go stale, so the next takeover can reconcile it.
      expect(mockUpdateSet).not.toHaveBeenCalled();
    }, 20_000);

    // The second half of the same bug: past the horizon the multicast registry has EVICTED the
    // entry, so getBufferedParts() returns [] meaning "no entry" — not "no content". The old
    // checkpoint serialized that [] straight over the parts column, erasing the crash-recovery
    // snapshot a client needs to restore mid-stream content after the originator's process dies.
    it('given a retry superseded this lifecycle, should stop checkpointing rather than write stale frames over the new generation', async () => {
      // The case the pre-inversion guard could not see. A retry/takeover opens a new channel on
      // the same messageId; this lifecycle's `finished` flag is still false and its interval is
      // still armed, so without an identity check it keeps writing ITS frames onto the row the
      // new generation now owns.
      const superseded = await createStreamLifecycle(params());
      superseded.channel.append(textStart);
      superseded.channel.append(textDelta('stale'));

      streamChannelRegistry.open('msg-1', {
        pageId: 'page-1',
        userId: 'user-1',
        displayName: 'Alice',
        conversationId: 'conv-1',
        browserSessionId: 'session-1',
      });
      mockUpdateSet.mockClear();

      await vi.advanceTimersByTimeAsync(CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS * 2);

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it('given the registry evicted this channel at the horizon, should stop checkpointing', async () => {
      const lifecycle = await createStreamLifecycle(params());
      lifecycle.channel.append(textStart);
      lifecycle.channel.append(textDelta('orphaned'));
      streamChannelRegistry.close('msg-1');
      mockUpdateSet.mockClear();

      await vi.advanceTimersByTimeAsync(CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS * 2);

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it('given the stream finishes, should stop beating', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
      await vi.advanceTimersByTimeAsync(0);
      mockUpdateSet.mockClear();

      await vi.advanceTimersByTimeAsync(120_000);

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });
  });

  describe('finish — completion path', () => {
    it('given finish(false), should call registry.finish, UPDATE the row to status=complete, and broadcast complete', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
      await flushMicrotasks();

      expect(lifecycle.channel.finished).toBe(true);
      expect(lifecycle.channel.aborted).toBe(false);
      expect(streamChannelRegistry.get('msg-1')).toBeUndefined();
      expect(mockUpdateSet).toHaveBeenCalledWith({
        status: 'complete',
        completedAt: expect.any(Date),
        parts: [],
        rawPartsCount: 0,
      });
      expect(mockBroadcastComplete).toHaveBeenCalledWith({
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
        aborted: false,
      });
    });

    it('given finish(true), should UPDATE the row to status=aborted and broadcast complete with aborted=true', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(true);
      await flushMicrotasks();

      expect(mockUpdateSet).toHaveBeenCalledWith({
        status: 'aborted',
        completedAt: expect.any(Date),
        parts: [],
        rawPartsCount: 0,
      });
      expect(mockBroadcastComplete).toHaveBeenCalledWith({
        messageId: 'msg-1',
        pageId: 'page-1',
        conversationId: 'conv-1',
        aborted: true,
      });
    });
  });

  describe('finish — idempotence', () => {
    it('given finish() is called twice, should fire registry.finish only once', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
      lifecycle.finish(false);
      await flushMicrotasks();

      expect(lifecycle.channel.finished).toBe(true);
    });

    it('given finish() is called twice, should fire the DB UPDATE only once', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
      lifecycle.finish(false);
      await flushMicrotasks();

      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
    });

    it('given finish() is called twice, should fire broadcastComplete only once', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
      lifecycle.finish(false);
      await flushMicrotasks();

      expect(mockBroadcastComplete).toHaveBeenCalledTimes(1);
    });

    it('given finish(true) followed by finish(false), should keep aborted=true on the broadcast (first call wins)', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(true);
      lifecycle.finish(false);
      await flushMicrotasks();

      expect(mockBroadcastComplete).toHaveBeenCalledTimes(1);
      expect(mockBroadcastComplete).toHaveBeenCalledWith(expect.objectContaining({ aborted: true }));
    });
  });

  describe('finish — invocation order', () => {
    it('given finish(), should close the channel, then DB UPDATE, then broadcastComplete in that order', async () => {
      // Ordering is load-bearing: subscribers must be told the stream ended before the row is
      // driven terminal, and the row must settle before anyone is told to reload from it.
      const lifecycle = await createStreamLifecycle(params());
      const probe = vi.fn();
      lifecycle.channel.subscribe({ fromSeq: 0, onFrame: () => {}, onEnd: () => probe() });

      mockUpdateSet.mockClear();
      mockBroadcastComplete.mockClear();

      lifecycle.finish(false);
      await flushMicrotasks();

      const finishOrder = probe.mock.invocationCallOrder[0];
      const updateOrder = mockUpdateSet.mock.invocationCallOrder[0];
      const broadcastOrder = mockBroadcastComplete.mock.invocationCallOrder[0];

      expect(finishOrder).toBeLessThan(updateOrder);
      expect(updateOrder).toBeLessThan(broadcastOrder);
    });
  });

  describe('finish — parts cleared on completion', () => {
    it('given a stream with buffered parts, should clear parts to empty in the final write rather than persist the full content', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
      await flushMicrotasks();

      // The only reader of this column filters status='streaming', so a
      // terminal row has nothing to gain from keeping the full content
      // around — and every AI reply is already durably saved via the normal
      // message-persistence path regardless of this table.
      expect(mockUpdateSet).toHaveBeenCalledWith({
        status: 'complete',
        completedAt: expect.any(Date),
        parts: [],
        rawPartsCount: 0,
      });

    });

    it('given a periodic persist is in flight when finish() is called, should await it before writing the final (cleared) snapshot', async () => {
      vi.useFakeTimers();
      let resolvePeriodic!: () => void;
      mockUpdateWhere.mockImplementationOnce(
        () => new Promise<void>((res) => { resolvePeriodic = res; }),
      );
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.channel.append(toolBoundary);
      await vi.advanceTimersByTimeAsync(0);

      mockUpdateSet.mockClear();
      lifecycle.finish(false);
      await vi.advanceTimersByTimeAsync(0);

      // The final write must not have landed yet — it's waiting on the
      // in-flight periodic persist to settle first.
      expect(mockUpdateSet).not.toHaveBeenCalled();

      resolvePeriodic();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateSet).toHaveBeenCalledWith({
        status: 'complete',
        completedAt: expect.any(Date),
        parts: [],
        rawPartsCount: 0,
      });

      vi.clearAllTimers();
      vi.useRealTimers();
    });
  });

  describe('finish — resilience', () => {
    it('given the DB UPDATE rejects, should warn and still broadcast complete', async () => {
      mockUpdateWhere.mockRejectedValueOnce(new Error('db dead'));
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
      await flushMicrotasks();

      expect(mockLoggerWarn).toHaveBeenCalled();
      expect(mockBroadcastComplete).toHaveBeenCalled();
    });

    it('given broadcastComplete rejects, should not throw synchronously out of finish()', async () => {
      mockBroadcastComplete.mockRejectedValueOnce(new Error('socket dead'));
      const lifecycle = await createStreamLifecycle(params());

      expect(() => lifecycle.finish(false)).not.toThrow();
    });

    it('given a subscriber throws while the channel closes, should still UPDATE and broadcast', async () => {
      // The channel swallows a subscriber's teardown throw so one bad joiner cannot block the
      // terminal write. Same guarantee the old registry.finish try/catch gave, enforced a level
      // down where the fan-out actually happens.
      const lifecycle = await createStreamLifecycle(params());
      lifecycle.channel.subscribe({
        fromSeq: 0,
        onFrame: () => {},
        onEnd: () => { throw new Error('bad subscriber'); },
      });
      mockUpdateSet.mockClear();

      expect(() => lifecycle.finish(false)).not.toThrow();
      await flushMicrotasks();

      expect(mockUpdateSet).toHaveBeenCalled();
      expect(mockBroadcastComplete).toHaveBeenCalled();
    });
  });

  // A Stop pressed during the route's preflight — or landing in the narrow gap between entering
  // createStreamLifecycle and the aiStreamSessions INSERT resolving — finds no row to mark and
  // writes a durable pending-abort intent instead. A single check right after the row exists
  // catches both cases: nothing else consumes the intent in between, so checking once here is
  // equivalent to checking before AND after the INSERT, without the extra DB round-trip.
  describe('pre-aborted: pending-abort intent consumed right after INSERT (#2028 item 1)', () => {
    it('given a pending-abort intent exists, should return preAborted=true', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      const handle = await createStreamLifecycle(params());

      expect(handle.preAborted).toBe(true);
    });

    it('given a pending-abort intent exists, should check exactly once', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      await createStreamLifecycle(params());

      expect(mockConsumePendingAbort).toHaveBeenCalledTimes(1);
    });

    it('given a pending-abort intent exists, should still open a channel (then close it)', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      const handle = await createStreamLifecycle(params());

      expect(handle.channel.finished).toBe(true);
      expect(handle.channel.aborted).toBe(true);
      expect(streamChannelRegistry.get('msg-1')).toBeUndefined();
    });

    it('given a pending-abort intent exists, should NOT broadcast stream_start', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      await createStreamLifecycle(params());

      expect(mockBroadcastStart).not.toHaveBeenCalled();
    });

    it('given a pending-abort intent exists, should INSERT as streaming then UPDATE the row to status=aborted', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      await createStreamLifecycle(params());

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'streaming' }),
      );
      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'aborted', parts: [], rawPartsCount: 0, abortRequestedAt: null }),
      );
      expect(mockUpdateWhere).toHaveBeenCalled();
    });

    it('given a pending-abort intent exists, should return a handle whose finish is a no-op', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      const handle = await createStreamLifecycle(params());
      // Creation itself flips the row to 'aborted', so clear first: what is under test is
      // that finish() adds NOTHING on top, not that the pre-abort path never writes.
      mockUpdateSet.mockClear();

      handle.finish(false);
      await flushMicrotasks();

      expect(mockUpdateSet).not.toHaveBeenCalled();
      expect(mockBroadcastComplete).not.toHaveBeenCalled();
    });

    it('given a pending-abort intent exists, the channel should refuse frames', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      const handle = await createStreamLifecycle(params());
      handle.channel.append(textStart);

      expect(handle.channel.getFrames()).toEqual([]);
    });

    it('given the pre-abort UPDATE rejects, should warn and still return preAborted=true', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);
      mockUpdateWhere.mockRejectedValueOnce(new Error('db down'));

      const handle = await createStreamLifecycle(params());

      expect(mockLoggerWarn).toHaveBeenCalled();
      expect(handle.preAborted).toBe(true);
    });

    it('given NO pending-abort intent, should proceed normally with preAborted=false', async () => {
      mockConsumePendingAbort.mockResolvedValue(false);

      const handle = await createStreamLifecycle(params());

      expect(handle.preAborted).toBe(false);
      expect(mockBroadcastStart).toHaveBeenCalled();
      // Not evicted — this is the normal, still-streaming path.
      expect(handle.channel.finished).toBe(false);
    });
  });

  describe('getParts — the folded view of everything captured', () => {
    it('given captured frames, should return the SDK reduction of them rather than a re-derived projection', async () => {
      const lifecycle = await createStreamLifecycle(params());
      lifecycle.channel.append(textStart);
      lifecycle.channel.append(textDelta('folded'));

      expect(await lifecycle.getParts()).toEqual([
        { type: 'text', text: 'folded', state: 'streaming', providerMetadata: undefined },
      ]);
    });

    it('given nothing captured, should return no parts', async () => {
      const lifecycle = await createStreamLifecycle(params());

      expect(await lifecycle.getParts()).toEqual([]);
    });

    it('given a pre-aborted handle, should return no parts', async () => {
      mockConsumePendingAbort.mockResolvedValueOnce(true);
      const handle = await createStreamLifecycle(params());

      expect(await handle.getParts()).toEqual([]);
    });
  });
});

/**
 * LEAF 4 — the checkpoint no longer truncates when the memory ring evicts.
 *
 * The lifecycle used to fold `channel.getFrames()`: whatever the ring still held. A reply long
 * enough to evict its oldest frames therefore wrote a snapshot that had silently lost its
 * beginning — and losing the beginning is not a partial loss, because the fold needs a part's
 * OPENING frame to attach its deltas to. Drop a `text-start` and every delta after it is
 * skipped as an orphan, so the reply does not shorten; it VANISHES.
 *
 * The lifecycle now folds each frame as it arrives, before eviction can reach it.
 *
 * DRIVEN THROUGH THE RING'S FRAME-COUNT CAP, not its byte cap, because that is the dimension
 * a real reply reaches: a long agent run emits tens of thousands of small deltas, which cost
 * the fold almost nothing (they accumulate INTO one text part) while filling the ring's
 * 50,000-frame budget. The byte dimension is where `MAX_FOLD_BYTES` lives instead — covered
 * separately below.
 */
describe('createStreamLifecycle — checkpoint survives ring eviction', () => {
  beforeEach(resetStreamLifecycleMocks);
  afterEach(finishTrackedLifecycles);

  /** One past the channel's DEFAULT_MAX_MEMORY_FRAMES, so the oldest frames are evicted. */
  const RING_FRAME_CAP = 50_000;
  const OPENING_TEXT = 'the beginning of the reply';

  /** Open a text part, write recognizable text, then bury it under an evicting flood. */
  const floodPastRingCap = (handle: { channel: { append: (c: UIMessageChunk) => void } }) => {
    handle.channel.append(textStart);
    handle.channel.append(textDelta(OPENING_TEXT));
    for (let i = 0; i < RING_FRAME_CAP; i += 1) handle.channel.append(textDelta('x'));
  };

  it('given a reply whose opening frames were evicted, should still persist them in the snapshot', async () => {
    const handle = await createStreamLifecycle(params());

    floodPastRingCap(handle);
    handle.channel.append(toolBoundary);
    await flushMicrotasks();
    await flushMicrotasks();

    // The ring really did evict — otherwise this test proves nothing.
    expect(handle.channel.firstAvailableSeq).toBeGreaterThan(0);

    const persisted = mockUpdateSet.mock.calls.at(-1)?.[0] as { parts: { type: string; text?: string }[] };
    const text = persisted.parts.find((p) => p.type === 'text')?.text ?? '';
    expect(text.startsWith(OPENING_TEXT)).toBe(true);
  });

  it('given evicted frames, should count them all in rawPartsCount rather than only what survived in memory', async () => {
    const handle = await createStreamLifecycle(params());

    floodPastRingCap(handle);
    handle.channel.append(toolBoundary);
    await flushMicrotasks();
    await flushMicrotasks();

    const persisted = mockUpdateSet.mock.calls.at(-1)?.[0] as { rawPartsCount: number };
    // Every frame was folded; the ring holds only its cap. The count describes the SNAPSHOT,
    // so it must be the folded total — an under-count makes an old client re-apply text it
    // has already rendered.
    expect(persisted.rawPartsCount).toBe(RING_FRAME_CAP + 3);
    expect(handle.channel.getFrames().length).toBeLessThan(RING_FRAME_CAP + 3);
  });

  it('given evicted frames, getParts() should return the whole reply, not the ring\'s remainder', async () => {
    const handle = await createStreamLifecycle(params());

    floodPastRingCap(handle);
    await flushMicrotasks();

    const parts = await handle.getParts();
    const text = (parts.find((p) => p.type === 'text') as { text?: string } | undefined)?.text ?? '';
    expect(text.startsWith(OPENING_TEXT)).toBe(true);
  });
});

/**
 * The running fold is BOUNDED. It holds the turn's reduction for the generation's lifetime,
 * which is what stops eviction truncating the snapshot — but an accumulator with no ceiling is
 * a worse failure than the truncation it fixes, because it can OOM the worker and take the
 * whole generation down (review finding — chatgpt-codex-connector, PR #2409).
 */
describe('createStreamLifecycle — the checkpoint fold is bounded', () => {
  beforeEach(resetStreamLifecycleMocks);
  afterEach(finishTrackedLifecycles);

  /** One frame large enough to blow the 24MB fold budget on its own. */
  const hugeFrame = chunk({ type: 'text-delta', id: 't1', delta: 'x'.repeat(25 * 1024 * 1024) });

  it('given a payload past the fold budget, should stop folding rather than grow without bound', async () => {
    const handle = await createStreamLifecycle(params());

    handle.channel.append(textStart);
    handle.channel.append(textDelta('kept'));
    handle.channel.append(hugeFrame);
    handle.channel.append(toolBoundary);
    await flushMicrotasks();
    await flushMicrotasks();

    const persisted = mockUpdateSet.mock.calls.at(-1)?.[0] as {
      parts: { type: string; text?: string }[];
      rawPartsCount: number;
    };
    // The frames before the cap are kept — the snapshot stays a valid PREFIX, never an
    // orphaned tail — and nothing from the cap onward is absorbed.
    expect(persisted.parts.find((p) => p.type === 'text')?.text).toBe('kept');
    expect(persisted.rawPartsCount).toBe(2);
  });

  it('given the fold capped, should say so once rather than fail silently', async () => {
    const handle = await createStreamLifecycle(params());

    handle.channel.append(textStart);
    handle.channel.append(hugeFrame);
    handle.channel.append(textDelta('after the cap'));
    await flushMicrotasks();

    const capWarnings = mockLoggerWarn.mock.calls.filter(([msg]) =>
      String(msg).includes('checkpoint fold hit its memory cap'));
    expect(capWarnings).toHaveLength(1);
  });

  it('given an ordinary reply, should not cap — the budget must not bite a normal turn', async () => {
    const handle = await createStreamLifecycle(params());

    writeText(handle, 'an ordinary reply');
    handle.channel.append(toolBoundary);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockLoggerWarn.mock.calls.filter(([msg]) =>
      String(msg).includes('checkpoint fold hit its memory cap'))).toHaveLength(0);
    const persisted = mockUpdateSet.mock.calls.at(-1)?.[0] as { parts: { type: string; text?: string }[] };
    expect(persisted.parts.find((p) => p.type === 'text')?.text).toBe('an ordinary reply');
  });
});

/**
 * The durable frame log is wired to the SAME channel every other subscriber reads. The
 * writer's own behaviour is covered in frame-log-writer.test.ts; what belongs here is that
 * the lifecycle starts one, ends it, and — the part with teeth — does NOT delete its frames.
 */
describe('createStreamLifecycle — durable frame log wiring', () => {
  beforeEach(resetStreamLifecycleMocks);
  afterEach(finishTrackedLifecycles);

  it('given a generation, should start a frame-log writer on this stream\'s own channel', async () => {
    const handle = await createStreamLifecycle(params());

    expect(mockStartFrameLogWriter).toHaveBeenCalledWith({
      messageId: 'msg-1',
      conversationId: 'conv-1',
      channel: handle.channel,
    });
  });

  it('given finish(), should close the frame log so its tail is written rather than dying with the process', async () => {
    const handle = await createStreamLifecycle(params());
    handle.finish(false);

    expect(mockFrameWriterClose).toHaveBeenCalled();
  });

  it('given finish(), should NOT release the frames — no terminal message write has been confirmed here', async () => {
    // The distinction the whole retention contract rests on. finish() also runs when the pump
    // failed and nothing was persisted at all, which is exactly the case the durable log
    // exists for; deleting here would throw away the only copy of the reply.
    const handle = await createStreamLifecycle(params());
    handle.finish(false);
    await flushMicrotasks();

    expect(mockFrameWriterRelease).not.toHaveBeenCalled();
    expect(mockReleaseFrames).not.toHaveBeenCalled();
  });

  it('given a confirmed terminal write but no finish() yet, should NOT release', async () => {
    // execute-end persists the buffered snapshot and `onFinish` then refines it. Releasing on
    // the first of those discards a tail the pump may still be forwarding into the channel
    // while that write is in flight.
    const handle = await createStreamLifecycle(params());
    handle.confirmTerminalWrite('msg-1');
    await flushMicrotasks();

    expect(mockFrameWriterRelease).not.toHaveBeenCalled();
  });

  it('given a confirmed terminal write and then finish(), should release', async () => {
    const handle = await createStreamLifecycle(params());
    handle.confirmTerminalWrite('msg-1');
    handle.finish(false);
    await flushMicrotasks();

    expect(mockFrameWriterRelease).toHaveBeenCalled();
  });

  it('given finish() FIRST and the confirmation afterwards, should still release', async () => {
    // The abort ordering: `onAbort` finishes the lifecycle immediately, and execute-end /
    // onFinish persist afterwards. The gate closes on whichever half arrives last.
    const handle = await createStreamLifecycle(params());
    handle.finish(true);
    await flushMicrotasks();
    expect(mockFrameWriterRelease).not.toHaveBeenCalled();

    handle.confirmTerminalWrite('msg-1');
    await flushMicrotasks();

    expect(mockFrameWriterRelease).toHaveBeenCalled();
  });

  it('given several terminal writes on one turn, should release exactly once', async () => {
    const handle = await createStreamLifecycle(params());
    handle.confirmTerminalWrite('msg-1');
    handle.confirmTerminalWrite('msg-1');
    handle.finish(false);
    handle.confirmTerminalWrite('msg-1');
    await flushMicrotasks();

    expect(mockFrameWriterRelease).toHaveBeenCalledTimes(1);
  });

  it('given a release, should NOT also close the writer — the flush it queues would be discarded', async () => {
    // `release()` abandons the writer, which cancels any batch a `close()` had queued. Calling
    // both made the flush a no-op while the comment claimed the tail had been written — and if
    // the delete then failed, the log was left as a prefix missing exactly that tail.
    const handle = await createStreamLifecycle(params());
    handle.confirmTerminalWrite('msg-1');
    handle.finish(false);
    await flushMicrotasks();

    expect(mockFrameWriterRelease).toHaveBeenCalledTimes(1);
    expect(mockFrameWriterClose).not.toHaveBeenCalled();
  });

  it('given NO confirmed write, should close the writer so the tail is actually persisted', async () => {
    // The pump-failure path, and the conversation-deleted-mid-generation path. These frames are
    // the only copy of the reply, so the tail genuinely has to be written here.
    const handle = await createStreamLifecycle(params());
    handle.finish(false);
    await flushMicrotasks();

    expect(mockFrameWriterClose).toHaveBeenCalled();
    expect(mockFrameWriterRelease).not.toHaveBeenCalled();
  });

  it('given a confirmation for another message, should ignore it', async () => {
    // The route helper that confirms is shared with writes that have no frame log — the help
    // responder's own message, for one. A foreign id must not arm this generation's release.
    const handle = await createStreamLifecycle(params());
    handle.confirmTerminalWrite('some-other-message');
    handle.finish(false);
    await flushMicrotasks();

    expect(mockFrameWriterRelease).not.toHaveBeenCalled();
  });

  it('given a pre-aborted stream, should release any frames left by the superseded attempt', async () => {
    mockConsumePendingAbort.mockResolvedValue(true);

    await createStreamLifecycle(params({ messageId: 'msg-preaborted' }));
    await flushMicrotasks();

    expect(mockReleaseFrames).toHaveBeenCalledWith('msg-preaborted');
  });

  it('given a pre-aborted stream, should not start a frame-log writer for a generation that never runs', async () => {
    mockConsumePendingAbort.mockResolvedValue(true);

    await createStreamLifecycle(params());

    expect(mockStartFrameLogWriter).not.toHaveBeenCalled();
  });
});

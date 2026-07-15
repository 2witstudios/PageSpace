import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  mockRegistryRegister,
  mockRegistryPush,
  mockRegistryFinish,
  mockRegistryGetBufferedParts,
  mockRegistryGetMeta,
  mockBroadcastStart,
  mockBroadcastComplete,
  mockInsertValues,
  mockInsertOnConflict,
  mockUpdateSet,
  mockUpdateWhere,
  mockLoggerWarn,
  mockConsumePendingAbort,
  mockEnsureWatcher,
  aiStreamSessionsToken,
} = vi.hoisted(() => ({
  mockRegistryRegister: vi.fn(),
  mockRegistryPush: vi.fn(),
  mockRegistryFinish: vi.fn(),
  mockRegistryGetBufferedParts: vi.fn().mockReturnValue([]),
  mockRegistryGetMeta: vi.fn().mockReturnValue({ pageId: 'page-1', userId: 'u1', displayName: 'U', conversationId: 'conv-1', browserSessionId: 's1' }),
  mockBroadcastStart: vi.fn().mockResolvedValue(undefined),
  mockBroadcastComplete: vi.fn().mockResolvedValue(undefined),
  mockInsertValues: vi.fn(),
  mockInsertOnConflict: vi.fn().mockResolvedValue(undefined),
  mockUpdateSet: vi.fn(),
  mockUpdateWhere: vi.fn().mockResolvedValue(undefined),
  mockLoggerWarn: vi.fn(),
  mockConsumePendingAbort: vi.fn().mockResolvedValue(false),
  mockEnsureWatcher: vi.fn(),
  aiStreamSessionsToken: { __table: 'ai_stream_sessions', messageId: 'message_id' },
}));

vi.mock('@/lib/ai/core/stream-multicast-registry', () => ({
  streamMulticastRegistry: {
    register: mockRegistryRegister,
    push: mockRegistryPush,
    finish: mockRegistryFinish,
    getBufferedParts: mockRegistryGetBufferedParts,
    // A REGISTERED stream has meta. The old fixture returned undefined — i.e. it modelled a
    // stream whose registry entry was already evicted — which was harmless only because
    // production never asked. It asks now: the parts checkpoint skips when the entry is gone,
    // because `getBufferedParts()` then returns `[]` meaning "no entry", and persisting that
    // would wipe the crash-recovery snapshot.
    getMeta: mockRegistryGetMeta,
    subscribe: vi.fn(),
  },
}));

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

const textPart = { type: 'text' as const, text: 'hello' };
const toolPart = {
  type: 'tool-list_pages' as const,
  toolCallId: 'tc1',
  toolName: 'list_pages',
  state: 'output-available' as const,
  input: { driveId: 'd1' },
  output: { pages: [] },
};

describe('createStreamLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsumePendingAbort.mockResolvedValue(false);
    mockEnsureWatcher.mockImplementation(() => {});
    // clearAllMocks() clears calls, NOT implementations — a mockReturnValue set inside one test
    // otherwise leaks into every test after it. These two drive the parts-checkpoint guards, so
    // a leak here silently changes what later tests are actually exercising.
    mockRegistryGetBufferedParts.mockReturnValue([]);
    mockRegistryGetMeta.mockReturnValue({ pageId: 'page-1', userId: 'u1', displayName: 'U', conversationId: 'conv-1', browserSessionId: 's1' });
    mockInsertOnConflict.mockResolvedValue(undefined);
    mockUpdateWhere.mockResolvedValue(undefined);
    mockBroadcastStart.mockResolvedValue(undefined);
    mockBroadcastComplete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const handle of activeLifecycles) {
      try {
        handle.finish(true);
      } catch {
        // best-effort cleanup only — a throw here must not fail an unrelated test
      }
    }
    activeLifecycles = [];
  });

  describe('register / insert / broadcastStart on creation', () => {
    it('given valid params, should register the messageId in the multicast registry with full meta', async () => {
      await createStreamLifecycle(params());

      expect(mockRegistryRegister).toHaveBeenCalledWith('msg-1', {
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

  describe('pushPart', () => {
    it('given a part, should forward it to the multicast registry under the messageId', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.pushPart(textPart);

      expect(mockRegistryPush).toHaveBeenCalledWith('msg-1', textPart);
    });

    it('given finish() already ran, should no-op instead of forwarding to the registry', async () => {
      const lifecycle = await createStreamLifecycle(params());
      lifecycle.finish(false);
      mockRegistryPush.mockClear();

      lifecycle.pushPart(textPart);

      expect(mockRegistryPush).not.toHaveBeenCalled();
    });

    it('given finish() already ran, should not count toward the checkpoint (would otherwise race the final write with an empty snapshot)', async () => {
      const lifecycle = await createStreamLifecycle(params());
      lifecycle.finish(false);
      mockUpdateSet.mockClear();

      for (let i = 0; i < 25; i++) lifecycle.pushPart(textPart);
      await flushMicrotasks();

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it('given the registry throws on push, should not throw out of pushPart', async () => {
      mockRegistryPush.mockImplementationOnce(() => { throw new Error('push'); });
      const lifecycle = await createStreamLifecycle(params());

      expect(() => lifecycle.pushPart(textPart)).not.toThrow();
    });

    it('given the registry throws on push, should warn-log so the swallow is observable', async () => {
      mockRegistryPush.mockImplementationOnce(() => { throw new Error('boom'); });
      const lifecycle = await createStreamLifecycle(params());

      mockLoggerWarn.mockClear();
      lifecycle.pushPart(textPart);

      expect(mockLoggerWarn).toHaveBeenCalled();
    });
  });

  describe('pushPart — time-based checkpoint cadence', () => {
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

    it('given a part pushed right after start, should not persist immediately (throttled to the dirty-flush window)', async () => {
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      lifecycle.pushPart(textPart);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it('given a dirty buffer and at least 1s elapsed since the last checkpoint, should persist on the next pushed part', async () => {
      const fakeParts = [textPart];
      mockRegistryGetBufferedParts.mockReturnValue(fakeParts);
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      lifecycle.pushPart(textPart);
      await vi.advanceTimersByTimeAsync(CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS);
      lifecycle.pushPart(textPart);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
      expect(mockUpdateSet).toHaveBeenCalledWith({
        parts: fakeParts,
        rawPartsCount: fakeParts.length,
        lastHeartbeatAt: expect.any(Date),
      });
    });

    it('given a tool-boundary part, should persist immediately even inside the 1s throttle window', async () => {
      const fakeParts = [toolPart];
      mockRegistryGetBufferedParts.mockReturnValue(fakeParts);
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      lifecycle.pushPart(toolPart);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
      expect(mockUpdateSet).toHaveBeenCalledWith({
        parts: fakeParts,
        rawPartsCount: fakeParts.length,
        lastHeartbeatAt: expect.any(Date),
      });
    });

    it('given a tool-boundary flush just landed, should still throttle the very next text part for 1s', async () => {
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.pushPart(toolPart);
      await vi.advanceTimersByTimeAsync(0);
      mockUpdateSet.mockClear();

      lifecycle.pushPart(textPart);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    // The whole reason for a dedicated interval, independent of pushPart: a stream sitting in a
    // long tool call pushes exactly one part (tool-input-available) and then nothing for minutes
    // — a rejoining client should still see that the tool started, not a snapshot frozen from
    // before the call began.
    it('given a dirty buffer and no further parts pushed, the unref\'d 1s interval should flush it mid-tool-call', async () => {
      const fakeParts = [toolPart];
      mockRegistryGetBufferedParts.mockReturnValue(fakeParts);
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      // A non-boundary text part first, so the tool-boundary bypass isn't what causes the
      // flush below — the throttle must still be respected...
      lifecycle.pushPart(textPart);
      await vi.advanceTimersByTimeAsync(0);
      expect(mockUpdateSet).not.toHaveBeenCalled();

      // ...until the interval ticks past the 1s window with nothing else pushed.
      await vi.advanceTimersByTimeAsync(CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS);

      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
      expect(mockUpdateSet).toHaveBeenCalledWith({
        parts: fakeParts,
        rawPartsCount: fakeParts.length,
        lastHeartbeatAt: expect.any(Date),
      });
    });

    it('given no parts pushed at all, the 1s interval should never persist (nothing dirty to flush)', async () => {
      await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      await vi.advanceTimersByTimeAsync(10 * CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS);

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it('given the checkpoint persist rejects, should warn and not throw', async () => {
      mockUpdateWhere.mockRejectedValueOnce(new Error('db down'));
      const lifecycle = await createStreamLifecycle(params());
      mockLoggerWarn.mockClear();

      lifecycle.pushPart(toolPart);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockLoggerWarn).toHaveBeenCalled();
    });

    it('given a persist is still in flight, should skip scheduling another until it settles', async () => {
      let resolveFirst!: () => void;
      mockUpdateWhere.mockImplementationOnce(
        () => new Promise<void>((res) => { resolveFirst = res; }),
      );
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      lifecycle.pushPart(toolPart);
      await vi.advanceTimersByTimeAsync(0);
      // A second tool-boundary part arrives while the first write is still in flight — the
      // in-flight guard must fold it into the next opportunity rather than race a second write.
      lifecycle.pushPart(toolPart);
      await vi.advanceTimersByTimeAsync(CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS);

      expect(mockUpdateSet).toHaveBeenCalledTimes(1);

      resolveFirst();
      await vi.advanceTimersByTimeAsync(0);
    });

    it('given consecutive text-delta parts pushed before a checkpoint, should merge them into one text part on the persisted snapshot', async () => {
      mockRegistryGetBufferedParts.mockReturnValue([
        { type: 'text', text: 'hel' },
        { type: 'text', text: 'lo' },
        { type: 'text', text: ' world' },
      ]);
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      lifecycle.pushPart(toolPart);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockUpdateSet).toHaveBeenCalledWith({
        parts: [{ type: 'text', text: 'hello world' }],
        // The RAW count (3 pushed chunks), NOT the merged array's length (1) — a rejoining
        // client's live-replay skip must be counted against the raw multicast buffer, which
        // the merged snapshot no longer has a 1:1 length relationship with.
        rawPartsCount: 3,
        lastHeartbeatAt: expect.any(Date),
      });
    });

    it('given a buffered snapshot over the ~5MB serialized cap, should truncate the oldest parts and warn exactly once across repeated checkpoints', async () => {
      const huge = { type: 'text' as const, text: 'x'.repeat(6 * 1024 * 1024) };
      const recent = { type: 'text' as const, text: 'recent' };
      mockRegistryGetBufferedParts.mockReturnValue([huge, toolPart, recent]);
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();
      mockLoggerWarn.mockClear();

      lifecycle.pushPart(toolPart);
      await vi.advanceTimersByTimeAsync(0);
      lifecycle.pushPart(toolPart);
      await vi.advanceTimersByTimeAsync(CHECKPOINT_DIRTY_FLUSH_INTERVAL_MS);

      expect(mockUpdateSet).toHaveBeenCalledTimes(2);
      for (const call of mockUpdateSet.mock.calls) {
        const written = call[0] as { parts: unknown[]; rawPartsCount: number };
        expect(written.parts).not.toContainEqual(huge);
        // D-task yfz5p85c584z3ekvdfc3qx4e: once capping drops `huge` (raw index 0), the seed
        // no longer reflects the frame(s) that fed it — reporting the raw total (3) here would
        // tell a rejoining client to skip past those frames too, permanently losing that
        // content (the live multicast replay is the only place it still exists). Reporting the
        // raw index the surviving content (`toolPart`, raw index 1) actually starts at instead
        // means the client only under-skips (harmless, self-correcting) rather than over-skips.
        expect(written.rawPartsCount).toBe(1);
      }
      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    });
  });

  // Liveness must NOT ride the parts checkpoint. A stream sitting in a long tool call
  // (sandbox exec, deep research, a slow MCP tool) pushes no parts for minutes — a
  // checkpoint-driven heartbeat would declare a perfectly healthy stream dead: it would
  // vanish from /active-streams so no client could attach, and the next send would fail
  // to abort it and would generate alongside it.
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
      mockRegistryGetBufferedParts.mockReturnValue([textPart, textPart]);
      const lifecycle = await createStreamLifecycle(params());

      // Past the horizon, but still generating hard. The 1s checkpoint interval makes this
      // ~61 minutes of fake time genuinely more timer-callback work than the 20s heartbeat
      // alone used to be, hence the longer wall-clock timeout below.
      await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
      mockUpdateSet.mockClear();

      for (let i = 0; i < 60; i++) lifecycle.pushPart(toolPart);
      await vi.advanceTimersByTimeAsync(0);

      // Not one write. The row is allowed to go stale, so the next takeover can reconcile it.
      expect(mockUpdateSet).not.toHaveBeenCalled();
    }, 20_000);

    // The second half of the same bug: past the horizon the multicast registry has EVICTED the
    // entry, so getBufferedParts() returns [] meaning "no entry" — not "no content". The old
    // checkpoint serialized that [] straight over the parts column, erasing the crash-recovery
    // snapshot a client needs to restore mid-stream content after the originator's process dies.
    it('given the registry entry is gone, should not overwrite the parts snapshot with an empty array', async () => {
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      // The registry evicted it (horizon), so it reports no entry and an empty buffer.
      mockRegistryGetMeta.mockReturnValue(undefined);
      mockRegistryGetBufferedParts.mockReturnValue([]);

      // Tool-boundary parts force an immediate checkpoint attempt, which is exactly the case
      // that must still respect the "entry gone" guard rather than write parts: [].
      lifecycle.pushPart(toolPart);
      await vi.advanceTimersByTimeAsync(0);

      const wroteEmptyParts = mockUpdateSet.mock.calls.some(
        (c) => Array.isArray((c[0] as { parts?: unknown }).parts)
          && ((c[0] as { parts: unknown[] }).parts).length === 0,
      );
      expect(wroteEmptyParts).toBe(false);
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

      expect(mockRegistryFinish).toHaveBeenCalledWith('msg-1', false);
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

      expect(mockRegistryFinish).toHaveBeenCalledTimes(1);
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
    it('given finish(), should call registry.finish, then DB UPDATE, then broadcastComplete in that order', async () => {
      const lifecycle = await createStreamLifecycle(params());

      mockRegistryFinish.mockClear();
      mockUpdateSet.mockClear();
      mockBroadcastComplete.mockClear();

      lifecycle.finish(false);
      await flushMicrotasks();

      const finishOrder = mockRegistryFinish.mock.invocationCallOrder[0];
      const updateOrder = mockUpdateSet.mock.invocationCallOrder[0];
      const broadcastOrder = mockBroadcastComplete.mock.invocationCallOrder[0];

      expect(finishOrder).toBeLessThan(updateOrder);
      expect(updateOrder).toBeLessThan(broadcastOrder);
    });
  });

  describe('finish — parts cleared on completion', () => {
    it('given a stream with buffered parts, should clear parts to empty in the final write rather than persist the full content', async () => {
      mockRegistryGetBufferedParts.mockReturnValue([textPart, textPart, textPart]);
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

      mockRegistryGetBufferedParts.mockReturnValue([]);
    });

    it('given a periodic persist is in flight when finish() is called, should await it before writing the final (cleared) snapshot', async () => {
      vi.useFakeTimers();
      let resolvePeriodic!: () => void;
      mockUpdateWhere.mockImplementationOnce(
        () => new Promise<void>((res) => { resolvePeriodic = res; }),
      );
      mockRegistryGetBufferedParts.mockReturnValue([toolPart]);
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.pushPart(toolPart);
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

      mockRegistryGetBufferedParts.mockReturnValue([]);
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

    it('given registry.finish throws, should still UPDATE and broadcast', async () => {
      mockRegistryFinish.mockImplementationOnce(() => { throw new Error('reg err'); });
      const lifecycle = await createStreamLifecycle(params());

      lifecycle.finish(false);
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

    it('given a pending-abort intent exists, should still register in the multicast registry (then evict it)', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      await createStreamLifecycle(params());

      expect(mockRegistryRegister).toHaveBeenCalled();
      expect(mockRegistryFinish).toHaveBeenCalledWith('msg-1', true);
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
      mockRegistryFinish.mockClear();

      handle.finish(false);
      await flushMicrotasks();

      expect(mockRegistryFinish).not.toHaveBeenCalled();
      expect(mockBroadcastComplete).not.toHaveBeenCalled();
    });

    it('given a pending-abort intent exists, pushPart should be a no-op', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      const handle = await createStreamLifecycle(params());
      handle.pushPart({ type: 'text', text: 'hello' });

      expect(mockRegistryPush).not.toHaveBeenCalled();
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
      expect(mockRegistryRegister).toHaveBeenCalled();
      expect(mockBroadcastStart).toHaveBeenCalled();
      // Not evicted — this is the normal, still-streaming path.
      expect(mockRegistryFinish).not.toHaveBeenCalled();
    });
  });

  describe('getBufferedParts', () => {
    it('delegates to streamMulticastRegistry.getBufferedParts with the messageId', async () => {
      const fakeParts = [{ type: 'text' as const, text: 'hi' }];
      mockRegistryGetBufferedParts.mockReturnValueOnce(fakeParts);
      const lifecycle = await createStreamLifecycle(params());

      const result = lifecycle.getBufferedParts();

      expect(mockRegistryGetBufferedParts).toHaveBeenCalledWith('msg-1');
      expect(result).toBe(fakeParts);
    });

    it('returns an empty array when the registry returns none', async () => {
      mockRegistryGetBufferedParts.mockReturnValueOnce([]);
      const lifecycle = await createStreamLifecycle(params());

      expect(lifecycle.getBufferedParts()).toEqual([]);
    });
  });
});

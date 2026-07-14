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

import { createStreamLifecycle } from '../stream-lifecycle';

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
    const textPart = { type: 'text' as const, text: 'hello' };

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

    it('given finish() already ran, should not count toward the periodic-persist checkpoint (would otherwise race the final write with an empty snapshot)', async () => {
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

  describe('pushPart — periodic parts persistence', () => {
    const textPart = { type: 'text' as const, text: 'hello' };

    it('given fewer than 20 pushes, should not persist parts to the DB', async () => {
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      for (let i = 0; i < 19; i++) lifecycle.pushPart(textPart);
      await flushMicrotasks();

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it('given exactly 20 pushes, should persist the buffered parts snapshot once', async () => {
      const fakeParts = [textPart, textPart];
      // Once: only the 20th push triggers the threshold's getBufferedParts read.
      mockRegistryGetBufferedParts.mockReturnValueOnce(fakeParts);
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      for (let i = 0; i < 20; i++) lifecycle.pushPart(textPart);
      await flushMicrotasks();

      expect(mockUpdateSet).toHaveBeenCalledTimes(1);
      // The parts checkpoint ALSO refreshes lastHeartbeatAt, on top of the independent
      // heartbeat timer (see the 'heartbeat' describe below) — so a busy stream's liveness
      // is never staler than its most recent checkpoint. The timer is what covers a stream
      // that pushes no parts at all, which no checkpoint-driven heartbeat could.
      expect(mockUpdateSet).toHaveBeenCalledWith({
        parts: fakeParts,
        lastHeartbeatAt: expect.any(Date),
      });
    });

    it('given 40 pushes across two batches, should persist once per batch', async () => {
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      for (let i = 0; i < 20; i++) lifecycle.pushPart(textPart);
      // Let the first (resolved) write settle before the next batch arrives —
      // otherwise the in-flight guard correctly folds both batches into one
      // write (see "should skip scheduling another until it settles" below).
      await flushMicrotasks();
      for (let i = 0; i < 20; i++) lifecycle.pushPart(textPart);
      await flushMicrotasks();

      expect(mockUpdateSet).toHaveBeenCalledTimes(2);
    });

    it('given the periodic persist rejects, should warn and not throw', async () => {
      mockUpdateWhere.mockRejectedValueOnce(new Error('db down'));
      const lifecycle = await createStreamLifecycle(params());
      mockLoggerWarn.mockClear();

      for (let i = 0; i < 20; i++) lifecycle.pushPart(textPart);
      await flushMicrotasks();

      expect(mockLoggerWarn).toHaveBeenCalled();
    });

    it('given a persist is still in flight, should skip scheduling another until it settles', async () => {
      let resolveFirst!: () => void;
      mockUpdateWhere.mockImplementationOnce(
        () => new Promise<void>((res) => { resolveFirst = res; }),
      );
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      for (let i = 0; i < 20; i++) lifecycle.pushPart(textPart);
      await flushMicrotasks();
      // Second batch arrives while the first write is still in flight.
      for (let i = 0; i < 20; i++) lifecycle.pushPart(textPart);
      await flushMicrotasks();

      expect(mockUpdateSet).toHaveBeenCalledTimes(1);

      resolveFirst();
      await flushMicrotasks();
    });
  });

  // Liveness must NOT ride the parts checkpoint. A stream sitting in a long tool call
  // (sandbox exec, deep research, a slow MCP tool) pushes no parts for minutes — a
  // checkpoint-driven heartbeat would declare a perfectly healthy stream dead: it would
  // vanish from /active-streams so no client could attach, and the next send would fail
  // to abort it and would generate alongside it.
  describe('heartbeat — an independent timer, not the parts checkpoint', () => {
    const textPart = { type: 'text' as const, text: 'hello' };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('given a stream that pushes NO parts at all (a long tool call), should still beat', async () => {
      const lifecycle = await createStreamLifecycle(params());
      mockUpdateSet.mockClear();

      await vi.advanceTimersByTimeAsync(60_000);

      expect(mockUpdateSet).toHaveBeenCalled();
      // Heartbeat-only: it must never touch `parts`, or it could race the checkpoint writes.
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
    it('given a lifecycle that never finishes, should stop beating after the cap rather than looking live forever', async () => {
      await createStreamLifecycle(params());

      // Still beating well inside the cap — a long-but-plausible generation must never be
      // cut off, or the next send would drive its LIVE row terminal.
      await vi.advanceTimersByTimeAsync(45 * 60 * 1000);
      expect(mockUpdateSet).toHaveBeenCalled();

      // Past the cap: the interval must have cancelled itself.
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      mockUpdateSet.mockClear();

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    // THE HOLE THE CAP DID NOT ACTUALLY CLOSE.
    //
    // Capping the interval beat is useless on its own, because `persistBufferedParts` ALSO
    // writes lastHeartbeatAt — and the parts checkpoint used to run with no deadline at all.
    // So the one generation most likely to outlive the cap (a long one, still chattering) kept
    // refreshing its own liveness FOREVER, which is precisely the immortal ghost the cap exists
    // to kill. And it is the worst possible ghost: by then BOTH registries have evicted it, so
    // /active-streams advertises a live, joinable stream that no client can join and whose Stop
    // button is a silent no-op, while the generation keeps running its tools and keeps billing.
    it('given a stream still pushing parts past the horizon, should stop refreshing its heartbeat rather than look live forever', async () => {
      mockRegistryGetBufferedParts.mockReturnValue([textPart, textPart]);
      const lifecycle = await createStreamLifecycle(params());

      // Past the horizon, but still generating hard.
      await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
      mockUpdateSet.mockClear();

      for (let i = 0; i < 60; i++) lifecycle.pushPart(textPart);
      await vi.advanceTimersByTimeAsync(0);

      // Not one write. The row is allowed to go stale, so the next takeover can reconcile it.
      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

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

      for (let i = 0; i < 40; i++) lifecycle.pushPart(textPart);
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
      const textPart = { type: 'text' as const, text: 'hello' };
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
      });

      mockRegistryGetBufferedParts.mockReturnValue([]);
    });

    it('given a periodic persist is in flight when finish() is called, should await it before writing the final (cleared) snapshot', async () => {
      let resolvePeriodic!: () => void;
      mockUpdateWhere.mockImplementationOnce(
        () => new Promise<void>((res) => { resolvePeriodic = res; }),
      );
      const textPart = { type: 'text' as const, text: 'hello' };
      mockRegistryGetBufferedParts.mockReturnValue([textPart]);
      const lifecycle = await createStreamLifecycle(params());

      for (let i = 0; i < 20; i++) lifecycle.pushPart(textPart);
      await flushMicrotasks();

      mockUpdateSet.mockClear();
      lifecycle.finish(false);
      await flushMicrotasks();

      // The final write must not have landed yet — it's waiting on the
      // in-flight periodic persist to settle first.
      expect(mockUpdateSet).not.toHaveBeenCalled();

      resolvePeriodic();
      await flushMicrotasks();

      expect(mockUpdateSet).toHaveBeenCalledWith({
        status: 'complete',
        completedAt: expect.any(Date),
        parts: [],
      });

      mockRegistryGetBufferedParts.mockReturnValue([]);
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

  describe('pre-aborted: pending-abort intent consumed at INSERT time (#2028 item 1)', () => {
    it('given a pending-abort intent exists, should return preAborted=true', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      const handle = await createStreamLifecycle(params());

      expect(handle.preAborted).toBe(true);
    });

    it('given a pending-abort intent exists, should NOT register in the multicast registry', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      await createStreamLifecycle(params());

      expect(mockRegistryRegister).not.toHaveBeenCalled();
    });

    it('given a pending-abort intent exists, should NOT broadcast stream_start', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      await createStreamLifecycle(params());

      expect(mockBroadcastStart).not.toHaveBeenCalled();
    });

    it('given a pending-abort intent exists, should INSERT the row as status=aborted', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      await createStreamLifecycle(params());

      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'aborted' }),
      );
    });

    it('given a pending-abort intent exists, should return a handle whose finish is a no-op', async () => {
      mockConsumePendingAbort.mockResolvedValue(true);

      const handle = await createStreamLifecycle(params());

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

    it('given NO pending-abort intent, should proceed normally with preAborted=false', async () => {
      mockConsumePendingAbort.mockResolvedValue(false);

      const handle = await createStreamLifecycle(params());

      expect(handle.preAborted).toBe(false);
      expect(mockRegistryRegister).toHaveBeenCalled();
      expect(mockBroadcastStart).toHaveBeenCalled();
    });
  });

  // A Stop landing in the gap between the pre-INSERT check above and the INSERT resolving is
  // recorded as a pending intent that the pre-INSERT check has already missed — left alone, the
  // generation runs to completion AND the orphaned intent poisons the NEXT send within its TTL.
  // This recheck closes that window.
  describe('pre-aborted: pending-abort intent recheck after INSERT (consume/insert race)', () => {
    it('given a pending-abort intent lands between the pre-INSERT check and the INSERT resolving, should return preAborted=true', async () => {
      mockConsumePendingAbort.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      const handle = await createStreamLifecycle(params());

      expect(mockConsumePendingAbort).toHaveBeenCalledTimes(2);
      expect(handle.preAborted).toBe(true);
    });

    it('given the late intent, should UPDATE (not INSERT) the already-inserted row to status=aborted', async () => {
      mockConsumePendingAbort.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await createStreamLifecycle(params());

      expect(mockUpdateSet).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'aborted', parts: [], abortRequestedAt: null }),
      );
      expect(mockUpdateWhere).toHaveBeenCalled();
    });

    it('given the late intent, should evict the multicast registry entry it just registered', async () => {
      mockConsumePendingAbort.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await createStreamLifecycle(params());

      expect(mockRegistryRegister).toHaveBeenCalled();
      expect(mockRegistryFinish).toHaveBeenCalledWith('msg-1', true);
    });

    it('given the late intent, should NOT broadcast stream_start', async () => {
      mockConsumePendingAbort.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      await createStreamLifecycle(params());

      expect(mockBroadcastStart).not.toHaveBeenCalled();
    });

    it('given the late intent, should return a handle whose finish/pushPart are no-ops', async () => {
      mockConsumePendingAbort.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

      const handle = await createStreamLifecycle(params());
      mockRegistryFinish.mockClear();
      mockBroadcastComplete.mockClear();

      handle.finish(false);
      handle.pushPart({ type: 'text', text: 'hello' });
      await flushMicrotasks();

      expect(mockRegistryFinish).not.toHaveBeenCalled();
      expect(mockBroadcastComplete).not.toHaveBeenCalled();
      expect(mockRegistryPush).not.toHaveBeenCalled();
    });

    it('given the post-insert UPDATE rejects, should warn and still return preAborted=true', async () => {
      mockConsumePendingAbort.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      mockUpdateWhere.mockRejectedValueOnce(new Error('db down'));

      const handle = await createStreamLifecycle(params());

      expect(mockLoggerWarn).toHaveBeenCalled();
      expect(handle.preAborted).toBe(true);
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

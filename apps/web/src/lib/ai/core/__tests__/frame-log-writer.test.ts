import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import { assert } from './riteway';

const { mockAppendFrameBatch, mockDeleteFrames, mockLoggerWarn } = vi.hoisted(() => ({
  mockAppendFrameBatch: vi.fn(),
  mockDeleteFrames: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

/**
 * The DB primitives are mocked; the CHANNEL is not.
 *
 * These cases are about batching — which frames end up in which row, and when — so the real
 * channel drives them exactly as the pump would, and the two DB calls are observed as the
 * boundary they are. `frame-log.ts`'s own suite covers the SQL side.
 */
vi.mock('../frame-log', () => ({
  appendFrameBatch: mockAppendFrameBatch,
  deleteFrames: mockDeleteFrames,
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() } },
}));

import type { UIMessageChunk } from 'ai';
import { openStreamChannel } from '../stream-channel';
import { startFrameLogWriter, releaseFramesForMessage } from '../frame-log-writer';
import { FRAME_FLUSH_MAX_FRAMES, FRAME_FLUSH_INTERVAL_MS } from '../frame-log-batching';

const chunk = (value: unknown): UIMessageChunk => value as UIMessageChunk;
const textDelta = (delta: string) => chunk({ type: 'text-delta', id: 't1', delta });
const toolBoundary = chunk({
  type: 'tool-input-available',
  toolCallId: 'tc1',
  toolName: 'search_pages',
  input: { q: 'invoices' },
});

/**
 * Let every queued write settle.
 *
 * Microtask ticks rather than `setImmediate`, because one case runs on fake timers where a
 * macrotask would never fire. The writer's chain is several `await`s deep per batch (the
 * pre-write delete, the insert, the chain's own catch), so this is generous on purpose.
 */
const settle = async () => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

const start = (messageId = 'msg-1') => {
  const channel = openStreamChannel({ messageId });
  const writer = startFrameLogWriter({ messageId, conversationId: 'conv-1', channel });
  return { channel, writer };
};

/** The batches actually written, in call order. */
const batches = () =>
  mockAppendFrameBatch.mock.calls.map(([batch]) => batch as {
    messageId: string;
    conversationId: string;
    fromSeq: number;
    frames: UIMessageChunk[];
  });

describe('startFrameLogWriter — batching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendFrameBatch.mockResolvedValue(true);
    mockDeleteFrames.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('given a fast token stream, holds frames back rather than writing one row per token', async () => {
    const { channel } = start();
    for (let i = 0; i < 10; i += 1) channel.append(textDelta(`t${i}`));
    await settle();

    assert({
      given: '10 text deltas well inside every flush trigger',
      should: 'write nothing yet — an append-only log per token is the amplification this avoids',
      actual: mockAppendFrameBatch.mock.calls.length,
      expected: 0,
    });
  });

  it(`given ${FRAME_FLUSH_MAX_FRAMES} frames, flushes them as ONE row`, async () => {
    const { channel } = start();
    for (let i = 0; i < FRAME_FLUSH_MAX_FRAMES; i += 1) channel.append(textDelta(`t${i}`));
    await settle();

    assert({
      given: 'exactly the frame cap in a burst',
      should: 'write a single batch covering [0, cap)',
      actual: batches().map((b) => ({ fromSeq: b.fromSeq, count: b.frames.length })),
      expected: [{ fromSeq: 0, count: FRAME_FLUSH_MAX_FRAMES }],
    });
  });

  it('given a burst spanning two caps, writes contiguous, non-overlapping seq ranges', async () => {
    const { channel } = start();
    for (let i = 0; i < FRAME_FLUSH_MAX_FRAMES * 2; i += 1) channel.append(textDelta(`t${i}`));
    await settle();

    assert({
      given: 'twice the frame cap',
      should: 'write two rows whose ranges abut exactly — seq numbers frames, not rows',
      actual: batches().map((b) => ({ fromSeq: b.fromSeq, count: b.frames.length })),
      expected: [
        { fromSeq: 0, count: FRAME_FLUSH_MAX_FRAMES },
        { fromSeq: FRAME_FLUSH_MAX_FRAMES, count: FRAME_FLUSH_MAX_FRAMES },
      ],
    });
  });

  it('given a tool boundary, flushes immediately rather than waiting on the throttle', async () => {
    const { channel } = start();
    channel.append(textDelta('a'));
    channel.append(toolBoundary);
    await settle();

    assert({
      given: 'a tool-input-available frame two frames into the stream',
      should: 'write both pending frames at once, so a rejoining client sees the tool call',
      actual: batches().map((b) => ({ fromSeq: b.fromSeq, types: b.frames.map((f) => f.type) })),
      expected: [{ fromSeq: 0, types: ['text-delta', 'tool-input-available'] }],
    });
  });

  it('given a step boundary, flushes immediately', async () => {
    const { channel } = start();
    channel.append(textDelta('a'));
    channel.append(chunk({ type: 'finish-step' }));
    await settle();

    assert({
      given: 'a finish-step frame',
      should: 'flush — a step boundary changes what the UI shows',
      actual: mockAppendFrameBatch.mock.calls.length,
      expected: 1,
    });
  });

  it('given tool ARGUMENT tokens, does NOT treat each as a boundary', async () => {
    // The bug that shipped and was caught in review: `startsWith('tool-')` makes
    // `tool-input-delta` — the model's arguments, one token at a time — a boundary, so every
    // argument token becomes its own durable write. Enumeration is what prevents that, and
    // this is the case that proves the enumeration is still in force.
    const { channel } = start();
    for (let i = 0; i < 10; i += 1) {
      channel.append(chunk({ type: 'tool-input-delta', toolCallId: 'tc1', inputTextDelta: `"a${i}"` }));
    }
    await settle();

    assert({
      given: '10 tool-input-delta frames',
      should: 'write nothing — argument tokens stream like text and must not each force a row',
      actual: mockAppendFrameBatch.mock.calls.length,
      expected: 0,
    });
  });

  it('given a quiet buffer, its own interval flushes it rather than holding it until the next frame', async () => {
    vi.useFakeTimers();
    const { channel } = start();
    channel.append(textDelta('a'));
    await settle();

    const beforeTick = mockAppendFrameBatch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FRAME_FLUSH_INTERVAL_MS * 2);
    await settle();

    assert({
      given: 'one frame and then silence — a long tool call after the last delta',
      should: 'flush on the interval, not sit in memory until the tool returns',
      actual: { beforeTick, afterTick: mockAppendFrameBatch.mock.calls.length },
      expected: { beforeTick: 0, afterTick: 1 },
    });
  });

  it('given the channel finishing, writes the tail rather than letting it die with the process', async () => {
    const { channel } = start();
    channel.append(textDelta('a tail nobody flushed'));
    channel.finish(false);
    await settle();

    assert({
      given: 'a generation that ended with frames still pending',
      should: 'flush them on the channel end',
      actual: batches().map((b) => b.frames.length),
      expected: [1],
    });
  });

  it('carries the messageId and conversationId every batch needs for its cascade', async () => {
    const { channel } = start('msg-carry');
    channel.append(toolBoundary);
    await settle();

    assert({
      given: 'any written batch',
      should: 'carry both identifiers — conversationId is what makes the GDPR cascade reach it',
      actual: batches().map((b) => ({ messageId: b.messageId, conversationId: b.conversationId })),
      expected: [{ messageId: 'msg-carry', conversationId: 'conv-1' }],
    });
  });
});

describe('startFrameLogWriter — a re-registered messageId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendFrameBatch.mockResolvedValue(true);
    mockDeleteFrames.mockResolvedValue(true);
  });

  it('deletes the prior generation\'s frames before writing any of its own', async () => {
    const { channel } = start('msg-retry');
    channel.append(toolBoundary);
    await settle();

    assert({
      given: 'a new writer for a messageId',
      should: 'delete that messageId\'s log first, or a joiner replays two generations spliced together',
      actual: {
        deleted: mockDeleteFrames.mock.calls.map(([id]) => id),
        wroteAfterDelete: mockAppendFrameBatch.mock.calls.length,
      },
      expected: { deleted: ['msg-retry'], wroteAfterDelete: 1 },
    });
  });

  it('given a retry, the SUPERSEDED writer\'s pending tail is never written after the delete', async () => {
    // The race this closes: attempt 1 has unflushed frames; attempt 2 starts, deletes the
    // log, and begins writing from seq 0 again. If attempt 1's tail landed after that
    // delete, the log would hold both generations under one messageId — the exact splice
    // the delete exists to prevent, reintroduced by the cleanup that was meant to stop it.
    const first = start('msg-retry');
    first.channel.append(textDelta('attempt one, never flushed'));
    await settle();

    const second = start('msg-retry');
    second.channel.append(toolBoundary);
    await settle();

    assert({
      given: 'a second writer opened on a messageId whose first writer still had frames buffered',
      should: 'write only the second generation\'s frames',
      actual: batches().map((b) => b.frames.map((f) => f.type)),
      expected: [['tool-input-available']],
    });
  });

  it('given the pre-write delete fails, writes nothing rather than splicing onto stale rows', async () => {
    mockDeleteFrames.mockResolvedValue(false);
    const { channel } = start('msg-stale');
    channel.append(toolBoundary);
    await settle();

    assert({
      given: 'a delete that could not clear a prior generation\'s rows',
      should: 'disable durability for this stream instead of writing into a log it does not own',
      actual: {
        writes: mockAppendFrameBatch.mock.calls.length,
        warned: mockLoggerWarn.mock.calls.some(([msg]) => String(msg).includes('could not clear prior frames')),
      },
      expected: { writes: 0, warned: true },
    });
  });
});

describe('startFrameLogWriter — error paths end the writer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendFrameBatch.mockResolvedValue(true);
    mockDeleteFrames.mockResolvedValue(true);
  });

  it('given a batch insert that fails, stops at the hole rather than writing past it', async () => {
    // A log with a gap is worse than a short one: the reader truncates at the gap anyway, so
    // every frame written after it is storage spent on content nothing will ever replay.
    mockAppendFrameBatch.mockResolvedValueOnce(false);
    const { channel } = start();

    channel.append(toolBoundary);
    await settle();
    channel.append(toolBoundary);
    await settle();

    assert({
      given: 'a first batch that failed to insert',
      should: 'attempt no further batches for this stream',
      actual: mockAppendFrameBatch.mock.calls.length,
      expected: 1,
    });
  });

  it('given a rejecting insert, disables durability rather than wedging on a poisoned chain', async () => {
    mockAppendFrameBatch.mockRejectedValue(new Error('connection reset'));
    const { channel, writer } = start();

    channel.append(toolBoundary);
    await settle();
    channel.append(toolBoundary);
    await settle();

    // Close must still resolve: a caller awaiting it (retention, the lifecycle) would
    // otherwise hang forever on a promise nothing can settle.
    await writer.close();

    assert({
      given: 'an insert that rejects rather than reporting failure',
      should: 'stop writing, warn, and still let close() resolve',
      actual: {
        writes: mockAppendFrameBatch.mock.calls.length,
        warned: mockLoggerWarn.mock.calls.some(([msg]) => String(msg).includes('write chain rejected')),
      },
      expected: { writes: 1, warned: true },
    });
  });

  it('given a channel that ALREADY finished, leaves no interval ticking behind it', async () => {
    // `channel.subscribe` ends synchronously for a finished channel, so `onEnd` -> `close()`
    // -> `terminate()` all run before `startFrameLogWriter` returns. With the interval armed
    // after the subscription, `terminate()` would have found it still null, the timer would
    // then be created with nobody owning it, and every later `terminate()` would return early
    // on `stopped` — a 200ms tick retaining this writer for the life of the process.
    //
    // The window is real: `createStreamLifecycle` opens the channel, then awaits the sessions
    // INSERT and `consumePendingAbort` before starting the writer, and a takeover landing in
    // that gap finishes the channel.
    vi.useFakeTimers();
    try {
      const channel = openStreamChannel({ messageId: 'msg-dead-on-arrival' });
      channel.finish(false);

      startFrameLogWriter({ messageId: 'msg-dead-on-arrival', conversationId: 'conv-1', channel });
      await settle();

      assert({
        given: 'a writer started on a channel that had already finished',
        should: 'leave zero timers pending',
        actual: vi.getTimerCount(),
        expected: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('given an ordinary close(), leaves no interval ticking behind it either', async () => {
    vi.useFakeTimers();
    try {
      const { channel, writer } = start('msg-clean-close');
      channel.append(textDelta('a'));
      await writer.close();

      assert({
        given: 'a writer closed the ordinary way',
        should: 'clear its flush interval',
        actual: vi.getTimerCount(),
        expected: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('given the per-stream durable budget exhausted, stops writing and says so', async () => {
    // The log becomes a PREFIX past the budget rather than growing without bound. Driven with
    // frames the channel's estimator cannot serialize (a circular payload), which it charges a
    // deliberately large flat amount — so this exhausts a 64MB budget in ~64 cheap frames
    // instead of allocating 64MB of test strings. `data-` frames are durability boundaries, so
    // each one flushes on arrival.
    const circular = (): UIMessageChunk => {
      const frame: Record<string, unknown> = { type: 'data-bulk' };
      frame.self = frame;
      return frame as unknown as UIMessageChunk;
    };

    const { channel } = start('msg-budget');
    const APPENDED = 80;
    for (let i = 0; i < APPENDED; i += 1) {
      channel.append(circular());
      await settle();
    }

    const writes = mockAppendFrameBatch.mock.calls.length;
    assert({
      given: 'a stream whose frames exceed the per-stream durable budget',
      should: 'stop writing partway and warn, rather than growing the log without bound',
      actual: {
        stoppedEarly: writes > 0 && writes < APPENDED,
        warned: mockLoggerWarn.mock.calls.some(([msg]) => String(msg).includes('durable budget exhausted')),
      },
      expected: { stoppedEarly: true, warned: true },
    });
  });

  it('given close(), stops accepting further frames', async () => {
    const { channel, writer } = start();
    await writer.close();

    channel.append(toolBoundary);
    await settle();

    assert({
      given: 'frames appended after the writer closed',
      should: 'write nothing — a closed writer is done, not paused',
      actual: mockAppendFrameBatch.mock.calls.length,
      expected: 0,
    });
  });

  it('given close() twice, is idempotent', async () => {
    const { channel, writer } = start();
    channel.append(textDelta('a'));
    await writer.close();
    await writer.close();

    assert({
      given: 'two closes on one writer',
      should: 'flush the tail exactly once',
      actual: mockAppendFrameBatch.mock.calls.length,
      expected: 1,
    });
  });

  it('given close(), flushes the tail; given abandon(), discards it', async () => {
    const closed = start('msg-closed');
    closed.channel.append(textDelta('tail'));
    await closed.writer.close();
    const afterClose = mockAppendFrameBatch.mock.calls.length;

    mockAppendFrameBatch.mockClear();
    const abandoned = start('msg-abandoned');
    abandoned.channel.append(textDelta('tail'));
    await abandoned.writer.abandon();
    // Finishing after the abandon is what makes this bite: it is the event that would
    // otherwise flush the tail, so an abandon that only stopped intake would show up here.
    abandoned.channel.finish(false);
    await settle();

    assert({
      given: 'the same pending tail under close() and under abandon()',
      should: 'write it on close and drop it on abandon — abandon precedes a delete that would race the write',
      actual: { afterClose, afterAbandon: mockAppendFrameBatch.mock.calls.length },
      expected: { afterClose: 1, afterAbandon: 0 },
    });
  });
});

describe('releaseFramesForMessage — the BY-NAME release, for callers holding no writer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendFrameBatch.mockResolvedValue(true);
    mockDeleteFrames.mockResolvedValue(true);
  });

  it('given a LIVE local writer, refuses to delete', async () => {
    // The merge-blocking hazard this guards. Liveness is heartbeat-based and the heartbeat
    // write swallows its own failures, so a Postgres blip longer than the stale window leaves
    // every in-flight row looking dead; when the DB returns, the next `/active-streams` poll
    // reaps them — on the very instance still generating them. Acting on that would set
    // `writesDisabled`, which is terminal and never re-armed, so the generation would stream
    // on to the user with no durable record at all.
    const { channel } = start('msg-still-live');
    channel.append(toolBoundary);
    await settle();

    mockDeleteFrames.mockClear();
    mockAppendFrameBatch.mockClear();
    await releaseFramesForMessage('msg-still-live');

    assert({
      given: 'a by-name release for a message this process is still generating',
      should: 'delete nothing — a live writer outranks whatever concluded the stream was over',
      actual: mockDeleteFrames.mock.calls.length,
      expected: 0,
    });

    // …and the writer is untouched: it can still record.
    channel.append(toolBoundary);
    await settle();
    assert({
      given: 'a refused by-name release',
      should: 'leave durability on for the rest of the generation',
      actual: mockAppendFrameBatch.mock.calls.length,
      expected: 1,
    });
  });

  it('given no local writer (the owning process died elsewhere), deletes', async () => {
    await releaseFramesForMessage('msg-not-ours');

    assert({
      given: 'a messageId this process never generated',
      should: 'delete — a miss means no local generation can be harmed',
      actual: mockDeleteFrames.mock.calls.map(([id]) => id),
      expected: ['msg-not-ours'],
    });
  });

  it('given a writer that already finished and deregistered, deletes', async () => {
    const { writer } = start('msg-finished');
    await writer.close();

    mockDeleteFrames.mockClear();
    await releaseFramesForMessage('msg-finished');

    assert({
      given: 'a by-name release after the generation ended normally',
      should: 'delete — the writer left the registry when it stopped being able to write',
      actual: mockDeleteFrames.mock.calls.map(([id]) => id),
      expected: ['msg-finished'],
    });
  });
});

describe('writer.release() — the INSTANCE release, used by the owning lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendFrameBatch.mockResolvedValue(true);
    mockDeleteFrames.mockResolvedValue(true);
  });

  it('given an INSERT still in flight, waits for it before deleting', async () => {
    // Without this ordering the in-flight write lands after the DELETE and resurrects a
    // partial log that nothing reclaims until the retention backstop sweeps it.
    let settleInsert: (ok: boolean) => void = () => {};
    mockAppendFrameBatch.mockImplementation(
      () => new Promise<boolean>((resolve) => { settleInsert = resolve; }),
    );

    const { channel, writer } = start('msg-race');
    channel.append(toolBoundary);
    await settle();

    mockDeleteFrames.mockClear();
    const releasing = writer.release();
    await settle();
    const deletesWhileInsertInFlight = mockDeleteFrames.mock.calls.length;

    settleInsert(true);
    await releasing;
    await settle();

    assert({
      given: 'a release while this writer\'s INSERT has not returned',
      should: 'hold the delete until that write settles, then delete',
      actual: { deletesWhileInsertInFlight, deletesAfter: mockDeleteFrames.mock.calls.length },
      expected: { deletesWhileInsertInFlight: 0, deletesAfter: 1 },
    });
  });

  it('given a pending tail, discards it rather than writing it into a log about to be deleted', async () => {
    const { channel, writer } = start('msg-tail');
    channel.append(textDelta('a tail nobody needs'));

    mockAppendFrameBatch.mockClear();
    await writer.release();
    channel.finish(false);
    await settle();

    assert({
      given: 'a release with frames still buffered',
      should: 'write nothing — the log is being deleted',
      actual: mockAppendFrameBatch.mock.calls.length,
      expected: 0,
    });
  });

  it('given a SUPERSEDED writer, does not delete its successor\'s log', async () => {
    // The worst failure in the module: a lifecycle that lost its messageId to a newer
    // generation wiping the durable record of a stream that is still running. Not reachable
    // today (server-minted ids, one lifecycle per send), guarded because every neighbouring
    // mechanism guards the same thing.
    const first = start('msg-superseded');
    const second = start('msg-superseded');
    await settle();

    mockDeleteFrames.mockClear();
    mockAppendFrameBatch.mockClear();
    await first.writer.release();

    assert({
      given: 'a release from a writer whose messageId was re-registered',
      should: 'delete nothing — the log now belongs to the successor',
      actual: mockDeleteFrames.mock.calls.length,
      expected: 0,
    });

    second.channel.append(toolBoundary);
    await settle();
    assert({
      given: 'the superseded release having run',
      should: 'leave the successor writing normally',
      actual: mockAppendFrameBatch.mock.calls.length,
      expected: 1,
    });
  });

  it('given a successor registering WHILE the release is awaiting its write chain, still refuses', async () => {
    // The TOCTOU the second identity check closes. `abandon()` waits out the in-flight write
    // chain — unbounded in time — and deregisters `self` on the way, so a writer that registers
    // during that window is invisible to a check made before it AND will not see `self` to wait
    // for. The stale DELETE would land on the successor's freshly inserted rows: the exact
    // failure the guard exists to prevent, through the guard.
    let settleInsert: (ok: boolean) => void = () => {};
    mockAppendFrameBatch.mockImplementation(
      () => new Promise<boolean>((resolve) => { settleInsert = resolve; }),
    );

    const first = start('msg-toctou');
    first.channel.append(toolBoundary);
    await settle();

    mockDeleteFrames.mockClear();
    const releasing = first.writer.release();
    await settle();

    // A new generation claims the messageId while the release is parked on its write chain.
    start('msg-toctou');
    settleInsert(true);
    await releasing;
    await settle();

    // Exactly ONE delete, and it is the successor's own pre-write clear — the thing every new
    // writer does before its first insert. A second would be the stale release landing on the
    // successor's rows, which is what the guard prevents.
    assert({
      given: 'a successor that registered during the release\'s await',
      should: 'leave only the successor\'s own pre-write clear, never a second stale delete',
      actual: mockDeleteFrames.mock.calls.filter(([id]) => id === 'msg-toctou').length,
      expected: 1,
    });
  });

  it('given a writer that still owns the messageId, deletes', async () => {
    const { writer } = start('msg-owner');
    await settle();

    mockDeleteFrames.mockClear();
    await writer.release();

    assert({
      given: 'a release from the writer that still owns the messageId',
      should: 'delete its log',
      actual: mockDeleteFrames.mock.calls.map(([id]) => id),
      expected: ['msg-owner'],
    });
  });
});

import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import { assert } from './riteway';
import type { UIMessageChunk } from 'ai';
import type { ChannelEnd } from '../stream-channel';
import type { FrameCursorRead } from '../frame-log-cursor';

const { mockReadFramesFrom, mockStatusRow, mockLoggerWarn } = vi.hoisted(() => ({
  mockReadFramesFrom: vi.fn(),
  mockStatusRow: vi.fn<() => Promise<unknown[]>>(),
  mockLoggerWarn: vi.fn(),
}));

/**
 * The cursor read is mocked at its module boundary; the CHANNEL is not.
 *
 * These cases are about the poller's behaviour — cadence, terminal classification, refcounting —
 * and the channel it drives is the real one, because "a follower is indistinguishable from a
 * local channel" is the property under test rather than an implementation note.
 * `frame-log-cursor.test.ts` covers the SQL side.
 */
vi.mock('../frame-log-cursor', () => ({ readFramesFrom: mockReadFramesFrom }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => mockStatusRow() }) }),
    }),
  },
}));

vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamSessions: { messageId: 'message_id', status: 'status' },
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() } },
}));

import { acquireRemoteChannel, resetRemoteFrameFollowers } from '../remote-frame-follower';

const frame = (n: number): UIMessageChunk => ({ type: 'text-delta', id: 't1', delta: `f${n}` });

/**
 * The SDK's own stream terminators, which are what prove a durable log holds a WHOLE
 * generation rather than a prefix the writer gave up on. See STREAM_TERMINATOR_FRAMES.
 */
const FINISH = { type: 'finish' } as UIMessageChunk;
const ABORT = { type: 'abort' } as UIMessageChunk;
const ERROR_FRAME = { type: 'error', errorText: 'boom' } as UIMessageChunk;

const read = (over: Partial<FrameCursorRead> = {}): FrameCursorRead => ({
  frames: [],
  nextSeq: 0,
  truncated: false,
  empty: false,
  ...over,
});

const STREAMING = [{ status: 'streaming' }];
const COMPLETE = [{ status: 'complete' }];
const ABORTED = [{ status: 'aborted' }];

/** Let the poller's awaits settle without advancing timers. */
const settle = async () => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

/** Run the next scheduled tick and let it settle. */
const nextTick = async () => {
  await vi.advanceTimersByTimeAsync(1000);
  await settle();
};

interface Watcher { frames: unknown[]; end: ChannelEnd | null }

const watch = (channel: { subscribe: (o: never) => () => void }): Watcher => {
  const w: Watcher = { frames: [], end: null };
  channel.subscribe({
    fromSeq: 0,
    onFrame: ({ chunk }: { chunk: unknown }) => w.frames.push(chunk),
    onEnd: (end: ChannelEnd) => { w.end = end; },
  } as never);
  return w;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetRemoteFrameFollowers();
  mockReadFramesFrom.mockResolvedValue(read({ empty: true }));
  mockStatusRow.mockResolvedValue(STREAMING);
});

afterEach(() => {
  resetRemoteFrameFollowers();
  vi.useRealTimers();
});

describe('acquireRemoteChannel — following another instance\'s log', () => {
  it('appends what the log holds onto a channel indistinguishable from a local one', async () => {
    mockReadFramesFrom.mockResolvedValueOnce(read({ frames: [frame(0), frame(1)], nextSeq: 2 }));

    const { channel } = acquireRemoteChannel('msg-1');
    const seen = watch(channel);
    await settle();

    assert({
      given: 'a remote generation with two durable frames',
      should: 'fan them out through the ordinary channel, seq-addressed',
      actual: { frames: seen.frames, nextSeq: channel.nextSeq },
      expected: { frames: [frame(0), frame(1)], nextSeq: 2 },
    });
  });

  it('always starts at seq 0, whatever cursor a subscriber holds', async () => {
    acquireRemoteChannel('msg-1');
    await settle();

    // A channel that began at a subscriber's cursor would answer `overflow` to every OTHER
    // subscriber below it — including the common case of a second tab on the same reply — and
    // `overflow` is a reseed, not a resume.
    assert({
      given: 'a newly acquired follower',
      should: 'read from seq 0',
      actual: mockReadFramesFrom.mock.calls[0][0],
      expected: { messageId: 'msg-1', fromSeq: 0 },
    });
  });

  it('advances its cursor rather than re-reading what it already served', async () => {
    mockReadFramesFrom
      .mockResolvedValueOnce(read({ frames: [frame(0)], nextSeq: 1 }))
      .mockResolvedValue(read({ nextSeq: 1 }));

    acquireRemoteChannel('msg-1');
    await settle();
    await nextTick();

    assert({
      given: 'a tick that delivered one frame',
      should: 'ask for what comes after it next time',
      actual: mockReadFramesFrom.mock.calls[1][0],
      expected: { messageId: 'msg-1', fromSeq: 1 },
    });
  });

  it('reads the session status ONLY on ticks that found nothing', async () => {
    mockReadFramesFrom.mockResolvedValue(read({ frames: [frame(0)], nextSeq: 1 }));

    acquireRemoteChannel('msg-1');
    await settle();
    await nextTick();

    // A tick that found frames has already proven the generation was alive. A status query per
    // frame batch would double this follower's query rate for no information at all.
    assert({
      given: 'ticks that keep finding frames',
      should: 'never query the session row',
      actual: mockStatusRow.mock.calls.length,
      expected: 0,
    });
  });

  // ── THE THREE HONEST ANSWERS AT TERMINAL ────────────────────────────────────────────────────
  //
  // `stream-lifecycle` deletes the frames on its terminal write, so "the row is over" and "the
  // frames are still there" are independent facts. Collapsing them is what would make a followed
  // reply silently shorter than the one the originating tab saw.

  it('given a terminal row whose log is still present AND terminated, serves the rest then ends cleanly', async () => {
    mockReadFramesFrom
      .mockResolvedValueOnce(read({ nextSeq: 0 }))
      .mockResolvedValueOnce(read({ frames: [frame(0), FINISH], nextSeq: 2 }));
    mockStatusRow.mockResolvedValue(COMPLETE);

    const { channel } = acquireRemoteChannel('msg-1');
    const seen = watch(channel);
    await settle();

    assert({
      given: 'a finished generation whose log survives and carries the stream terminator',
      should: 'deliver the tail and end WITHOUT asking for a reload',
      actual: { frames: seen.frames, end: seen.end },
      expected: {
        frames: [frame(0), FINISH],
        end: { reason: 'finished', aborted: false, truncated: false },
      },
    });
  });

  // ── A NON-EMPTY LOG IS NOT A COMPLETE ONE ───────────────────────────────────────────────────
  //
  // `frame-log-writer` stops early in three documented ways (pre-write delete failed, batch
  // insert failed, durable budget exhausted), and every one leaves a valid, contiguous,
  // HOLE-FREE prefix. Without a completeness proof that reads as a clean end: `empty` false,
  // `truncated` false, and — because frames were delivered — `joinFailed` false too. The user
  // keeps a truncated reply nothing ever reloads.

  it('given a surviving log that never terminated, asks for a reload rather than ending cleanly', async () => {
    mockReadFramesFrom
      .mockResolvedValueOnce(read({ frames: [frame(0), frame(1)], nextSeq: 2 }))
      .mockResolvedValue(read({ nextSeq: 2 }));
    mockStatusRow.mockResolvedValue(COMPLETE);

    const { channel } = acquireRemoteChannel('msg-1');
    const seen = watch(channel);
    await settle();
    await nextTick();

    assert({
      given: 'a writer that gave up partway, leaving a hole-free PREFIX',
      should: 'keep the frames but end truncated — a short log must not read as a complete one',
      actual: { frames: seen.frames.length, truncated: seen.end?.truncated },
      expected: { frames: 2, truncated: true },
    });
  });

  it('accepts an abort frame as proof of completeness', async () => {
    mockReadFramesFrom
      .mockResolvedValueOnce(read({ nextSeq: 0 }))
      .mockResolvedValueOnce(read({ frames: [frame(0), ABORT], nextSeq: 2 }));
    mockStatusRow.mockResolvedValue(ABORTED);

    const { channel } = acquireRemoteChannel('msg-1');
    const seen = watch(channel);
    await settle();

    // A stopped generation is still a COMPLETE record of what it produced — the SDK's `abort`
    // frame is its terminator, and the client's bubble should not be replaced by a reload.
    assert({
      given: 'a Stopped generation whose log carries the abort terminator',
      should: 'end aborted but not truncated',
      actual: { aborted: seen.end?.aborted, truncated: seen.end?.truncated },
      expected: { aborted: true, truncated: false },
    });
  });

  it('accepts the pump\'s synthetic error frame as proof of completeness', async () => {
    mockReadFramesFrom
      .mockResolvedValueOnce(read({ nextSeq: 0 }))
      .mockResolvedValueOnce(read({ frames: [frame(0), ERROR_FRAME], nextSeq: 2 }));
    mockStatusRow.mockResolvedValue(COMPLETE);

    const { channel } = acquireRemoteChannel('msg-1');
    const seen = watch(channel);
    await settle();

    // The pump appends this and then stops reading, so it is the last frame there will ever be.
    assert({
      given: 'a generation whose SDK stream threw',
      should: 'treat the recorded error as the end of the record, not as a truncation',
      actual: seen.end?.truncated,
      expected: false,
    });
  });

  it('remembers a terminator seen on an EARLIER tick', async () => {
    mockReadFramesFrom
      .mockResolvedValueOnce(read({ frames: [frame(0), FINISH], nextSeq: 2 }))
      .mockResolvedValue(read({ nextSeq: 2 }));
    mockStatusRow.mockResolvedValue(COMPLETE);

    const { channel } = acquireRemoteChannel('msg-1');
    const seen = watch(channel);
    await settle();
    await nextTick();

    // The terminal branch runs on a LATER tick than the one that delivered the terminator, so
    // the proof has to be remembered rather than re-derived from the final read.
    assert({
      given: 'a terminator delivered before the row went terminal',
      should: 'still count as proof when the follower ends',
      actual: seen.end?.truncated,
      expected: false,
    });
  });

  it('given a terminal row whose log was RELEASED, ends asking for a reload', async () => {
    mockReadFramesFrom.mockResolvedValue(read({ empty: true }));
    mockStatusRow.mockResolvedValue(COMPLETE);

    const { channel } = acquireRemoteChannel('msg-1');
    const seen = watch(channel);
    await settle();

    // Retention deleted the frames once the terminal `messages` row was confirmed. The reply is
    // durably saved and this follower cannot prove it delivered all of it — so it says so,
    // rather than handing over a clean end for a possibly-short bubble.
    assert({
      given: 'a finished generation whose frames retention already reclaimed',
      should: 'end with truncated, which the route turns into `reload`',
      actual: seen.end,
      expected: { reason: 'finished', aborted: false, truncated: true },
    });
  });

  it('given an aborted row, carries aborted through', async () => {
    mockReadFramesFrom
      .mockResolvedValueOnce(read({ nextSeq: 0 }))
      .mockResolvedValueOnce(read({ nextSeq: 0, empty: true }));
    mockStatusRow.mockResolvedValue(ABORTED);

    const { channel } = acquireRemoteChannel('msg-1');
    const seen = watch(channel);
    await settle();

    assert({
      given: 'a generation that was Stopped',
      should: 'report aborted, the same distinction a local end makes',
      actual: seen.end?.aborted,
      expected: true,
    });
  });

  it('given the row is GONE, ends as truncated rather than as a clean finish', async () => {
    mockReadFramesFrom.mockResolvedValue(read({ empty: true }));
    mockStatusRow.mockResolvedValue([]);

    const { channel } = acquireRemoteChannel('msg-1');
    const seen = watch(channel);
    await settle();

    // A conversation hard-deleted mid-follow, or a retention sweep. Not "finished", and nothing
    // durable remains to reload from either — but a clean end would leave a partial bubble
    // looking whole.
    assert({
      given: 'a session row that vanished mid-follow',
      should: 'end truncated',
      actual: { aborted: seen.end?.aborted, truncated: seen.end?.truncated },
      expected: { aborted: true, truncated: true },
    });
  });

  it('given an UNREADABLE status, keeps following rather than declaring the stream over', async () => {
    mockReadFramesFrom.mockResolvedValue(read({ nextSeq: 0 }));
    mockStatusRow.mockRejectedValue(new Error('db down'));

    const { channel } = acquireRemoteChannel('msg-1');
    const seen = watch(channel);
    await settle();

    // Ending on a DB blip would tell every viewer the reply had finished while it was still
    // being generated — the exact failure this workstream exists to end.
    assert({
      given: 'a status read that threw',
      should: 'leave the channel open',
      actual: { end: seen.end, finished: channel.finished },
      expected: { end: null, finished: false },
    });
  });

  it('given a HOLE in the log, ends truncated and keeps the valid prefix', async () => {
    mockReadFramesFrom.mockResolvedValueOnce(read({ frames: [frame(0)], nextSeq: 1, truncated: true }));

    const { channel } = acquireRemoteChannel('msg-1');
    const seen = watch(channel);
    await settle();

    assert({
      given: 'a log the reader cannot fold past',
      should: 'keep what came before the hole and end truncated — never fold across it',
      actual: { frames: seen.frames, truncated: seen.end?.truncated },
      expected: { frames: [frame(0)], truncated: true },
    });
  });

  // ── CADENCE ─────────────────────────────────────────────────────────────────────────────────

  it('backs off after consecutive empty ticks', async () => {
    mockReadFramesFrom.mockResolvedValue(read({ nextSeq: 0 }));

    acquireRemoteChannel('msg-1');
    await settle();

    // Four empty ticks at the fast cadence, then the fifth is scheduled slowly.
    for (let i = 0; i < 4; i += 1) {
      await vi.advanceTimersByTimeAsync(250);
      await settle();
    }
    const beforeIdleWindow = mockReadFramesFrom.mock.calls.length;
    await vi.advanceTimersByTimeAsync(250);
    await settle();

    assert({
      given: 'a stream sitting in a long tool call',
      should: 'stop polling four times a second',
      actual: mockReadFramesFrom.mock.calls.length,
      expected: beforeIdleWindow,
    });
  });

  it('returns to the fast cadence the moment a frame arrives', async () => {
    mockReadFramesFrom.mockResolvedValue(read({ nextSeq: 0 }));

    acquireRemoteChannel('msg-1');
    await settle();
    // Sink well into the idle cadence.
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      await settle();
    }

    // One frame — the stream is chatty again.
    mockReadFramesFrom.mockResolvedValueOnce(read({ frames: [frame(0)], nextSeq: 1 }));
    await vi.advanceTimersByTimeAsync(1000);
    await settle();

    // …then one quiet tick. THIS is where the reset shows: without it the empty counter is
    // still above the threshold and the follower would schedule the NEXT read a second out
    // instead of 250ms out, staying four times slower for the rest of a chatty reply.
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    const afterFirstQuietTick = mockReadFramesFrom.mock.calls.length;

    await vi.advanceTimersByTimeAsync(250);
    await settle();

    assert({
      given: 'a stream that went quiet, spoke again, then paused for one tick',
      should: 'still be polling at the fast cadence — the backoff resets on any frame',
      actual: mockReadFramesFrom.mock.calls.length > afterFirstQuietTick,
      expected: true,
    });
  });

  // ── REFCOUNTING ─────────────────────────────────────────────────────────────────────────────

  it('given co-located readers, shares ONE poller and one channel', async () => {
    mockReadFramesFrom.mockResolvedValue(read({ nextSeq: 0 }));

    const a = acquireRemoteChannel('msg-1');
    const b = acquireRemoteChannel('msg-1');
    await settle();

    // Without this, N tabs on one instance is N pollers against the same rows, and a follower's
    // load on Postgres scales with viewers rather than with streams.
    assert({
      given: 'two tabs on this instance watching one remote reply',
      should: 'hand both the same channel and start one poller',
      actual: { sameChannel: a.channel === b.channel, initialReads: mockReadFramesFrom.mock.calls.length },
      expected: { sameChannel: true, initialReads: 1 },
    });
  });

  it('keeps polling while any reader remains', async () => {
    mockReadFramesFrom.mockResolvedValue(read({ nextSeq: 0 }));

    const a = acquireRemoteChannel('msg-1');
    acquireRemoteChannel('msg-1');
    await settle();
    a.release();

    // WELL PAST the linger window, twice — a follower that ignored the refcount would have
    // started lingering on this release and stopped, so the second window is what discriminates.
    // Checking only the first would pass on the broken version, since the linger itself keeps
    // polling for five seconds.
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    const afterFirstWindow = mockReadFramesFrom.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();

    assert({
      given: 'one of two readers leaving',
      should: 'go on following indefinitely for the other, not linger and stop',
      actual: mockReadFramesFrom.mock.calls.length > afterFirstWindow,
      expected: true,
    });
  });

  it('lingers after the last reader leaves, then stops', async () => {
    mockReadFramesFrom.mockResolvedValue(read({ nextSeq: 0 }));

    const a = acquireRemoteChannel('msg-1');
    await settle();
    a.release();

    // A reconnect — a network blip, a reseed, a pane remounting — would otherwise pay for a cold
    // read from seq 0 for a stream this instance was following a moment ago.
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    const duringLinger = mockReadFramesFrom.mock.calls.length;

    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    const afterLinger = mockReadFramesFrom.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();

    assert({
      given: 'the last reader leaving',
      should: 'keep polling briefly, then stop',
      actual: {
        polledDuringLinger: duringLinger > 1,
        stoppedAfter: mockReadFramesFrom.mock.calls.length === afterLinger,
      },
      expected: { polledDuringLinger: true, stoppedAfter: true },
    });
  });

  it('given a reader returning during the linger, keeps the warm follower', async () => {
    mockReadFramesFrom.mockResolvedValue(read({ nextSeq: 0 }));

    const a = acquireRemoteChannel('msg-1');
    await settle();
    a.release();
    const b = acquireRemoteChannel('msg-1');

    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    const before = mockReadFramesFrom.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000);
    await settle();

    assert({
      given: 'a reconnect inside the linger window',
      should: 'cancel the linger and go on polling, rather than cold-starting from seq 0',
      actual: { sameChannel: a.channel === b.channel, stillPolling: mockReadFramesFrom.mock.calls.length > before },
      expected: { sameChannel: true, stillPolling: true },
    });
  });

  it('release is idempotent, so a double teardown cannot orphan another reader\'s poller', async () => {
    mockReadFramesFrom.mockResolvedValue(read({ nextSeq: 0 }));

    const a = acquireRemoteChannel('msg-1');
    const b = acquireRemoteChannel('msg-1');
    await settle();
    a.release();
    // A double release that decremented twice would take the refcount to zero and strand the
    // reader that never let go.
    a.release();

    await vi.advanceTimersByTimeAsync(20_000);
    await settle();
    const afterFirstWindow = mockReadFramesFrom.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    await settle();

    assert({
      given: 'one reader releasing twice while another still holds the follower',
      should: 'keep following for the reader that remains',
      actual: mockReadFramesFrom.mock.calls.length > afterFirstWindow,
      expected: true,
    });
    b.release();
  });
});

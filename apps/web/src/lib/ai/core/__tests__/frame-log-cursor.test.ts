import { describe, it, beforeEach, vi } from 'vitest';
import { assert } from './riteway';

/**
 * A REAL in-memory `ai_stream_frames`, driven through the module's own two queries.
 *
 * The whole point of this leaf is WHICH rows it asks for and how it walks them, so a mock that
 * replayed one canned array to both passes would make every contiguity and cursor case vacuous.
 * The store below models the table; the db mock routes each query shape to it.
 */
interface Row { messageId: string; fromSeq: number; frameCount: number; frames: unknown[]; byteSize: number }
let table: Row[] = [];
let seekError: Error | null = null;
let rangeError: Error | null = null;

const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: (projection: Record<string, unknown>) => {
      // `max(from_seq)` — the containing-row seek. Distinguished by the marker the `max` mock
      // below returns, so the two selects cannot be confused for one another.
      const isSeek = (projection.fromSeq as { max?: unknown } | undefined)?.max !== undefined;
      const isPayload = 'frames' in projection;

      const run = (cond: Cond): Row[] | { fromSeq: number | null }[] => {
        const rows = table
          .filter((r) => r.messageId === cond.messageId)
          .filter((r) => (cond.lte === undefined ? true : r.fromSeq <= cond.lte))
          .filter((r) => (cond.gte === undefined ? true : r.fromSeq >= cond.gte))
          .sort((a, b) => a.fromSeq - b.fromSeq);

        if (isSeek) {
          if (seekError) throw seekError;
          const highest = rows.length === 0 ? null : rows[rows.length - 1].fromSeq;
          return [{ fromSeq: highest }];
        }
        if (rangeError && isPayload) throw rangeError;
        if (seekError && !isPayload) throw seekError;
        return rows;
      };

      const chain = (cond: Cond) => ({
        orderBy: () => Object.assign(Promise.resolve(run(cond)), {
          limit: (n: number) => Promise.resolve((run(cond) as Row[]).slice(0, n)),
        }),
        then: (resolve: (rows: unknown) => unknown) => Promise.resolve(run(cond)).then(resolve),
      });

      return { from: () => ({ where: (cond: Cond) => chain(cond) }) };
    },
  },
}));

interface Cond { messageId: string; lte?: number; gte?: number }

/**
 * Operators collapsed into the ONE thing the queries express: a messageId plus optional seq
 * bounds. Keeps the store above readable without pretending to be a SQL engine.
 */
vi.mock('@pagespace/db/operators', () => ({
  and: (...args: Partial<Cond>[]) => Object.assign({}, ...args),
  eq: (_f: unknown, v: string) => ({ messageId: v }),
  lte: (_f: unknown, v: number) => ({ lte: v }),
  gte: (_f: unknown, v: number) => ({ gte: v }),
  asc: (f: unknown) => f,
  max: (f: unknown) => ({ max: f }),
}));

vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamFrames: {
    messageId: 'message_id',
    fromSeq: 'from_seq',
    frameCount: 'frame_count',
    frames: 'frames',
    byteSize: 'byte_size',
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() } },
}));

import { readFramesFrom } from '../frame-log-cursor';

const frame = (n: number) => ({ type: 'text-delta', id: 't1', delta: `f${n}` });

const row = (fromSeq: number, count: number, byteSize = 100): Row => ({
  messageId: 'msg-1',
  fromSeq,
  frameCount: count,
  frames: Array.from({ length: count }, (_, i) => frame(fromSeq + i)),
  byteSize,
});

const deltas = (frames: unknown[]) => frames.map((f) => (f as { delta: string }).delta);

beforeEach(() => {
  vi.clearAllMocks();
  table = [];
  seekError = null;
  rangeError = null;
});

describe('readFramesFrom — the cursor', () => {
  it('given a cursor of 0 and a whole log, returns everything in seq order', async () => {
    table = [row(0, 3), row(3, 2)];

    const read = await readFramesFrom({ messageId: 'msg-1', fromSeq: 0 });

    assert({
      given: 'a fresh follower starting at seq 0',
      should: 'return every frame, contiguous, with the next cursor past the end',
      actual: { frames: deltas(read.frames), nextSeq: read.nextSeq, truncated: read.truncated },
      expected: { frames: ['f0', 'f1', 'f2', 'f3', 'f4'], nextSeq: 5, truncated: false },
    });
  });

  it('given a cursor INSIDE a row, slices that row\'s earlier frames off', async () => {
    table = [row(0, 4)];

    const read = await readFramesFrom({ messageId: 'msg-1', fromSeq: 2 });

    // The containing-row seek deliberately starts the walk BEFORE the cursor — that is what
    // makes the query use the `(message_id, from_seq)` primary key instead of scanning on
    // `from_seq + frame_count > $X`, which is not sargable. The overshoot is sliced here.
    assert({
      given: 'a cursor part-way through a batch',
      should: 'return only the frames after it',
      actual: { frames: deltas(read.frames), nextSeq: read.nextSeq },
      expected: { frames: ['f2', 'f3'], nextSeq: 4 },
    });
  });

  it('given a cursor exactly at a row boundary, returns that row whole', async () => {
    table = [row(0, 2), row(2, 2)];

    const read = await readFramesFrom({ messageId: 'msg-1', fromSeq: 2 });

    assert({
      given: 'a cursor on a batch boundary',
      should: 'return that batch and nothing before it',
      actual: deltas(read.frames),
      expected: ['f2', 'f3'],
    });
  });

  it('given a cursor at the end of the log, returns nothing and holds the cursor', async () => {
    table = [row(0, 3)];

    const read = await readFramesFrom({ messageId: 'msg-1', fromSeq: 3 });

    assert({
      given: 'a follower that is fully caught up',
      should: 'return no frames and leave the cursor where it was',
      actual: { frames: read.frames.length, nextSeq: read.nextSeq, truncated: read.truncated, empty: read.empty },
      expected: { frames: 0, nextSeq: 3, truncated: false, empty: false },
    });
  });

  // ── CONTIGUITY ──────────────────────────────────────────────────────────────────────────────
  //
  // Folding across a hole does not produce a slightly-wrong message; it produces a confidently
  // wrong one — a `tool-output-available` whose `tool-input-start` fell in the gap attaches to
  // nothing, and text after the gap concatenates as though the missing tokens were never spoken.
  // Here it is being streamed to a LIVE reader, who has no way to tell.

  it('given a HOLE, stops at it and reports truncated — never skips the gap', async () => {
    table = [row(0, 2), row(5, 2)];

    const read = await readFramesFrom({ messageId: 'msg-1', fromSeq: 0 });

    assert({
      given: 'a log missing seqs 2-4',
      should: 'return the contiguous prefix only, and say it is truncated',
      actual: { frames: deltas(read.frames), nextSeq: read.nextSeq, truncated: read.truncated },
      expected: { frames: ['f0', 'f1'], nextSeq: 2, truncated: true },
    });
  });

  it('given a log that BEGINS after the cursor, serves nothing and reports truncated', async () => {
    // Not "empty" — the rows exist, they just start past this reader. Serving from the first
    // surviving row would hand it a gap it cannot see.
    table = [row(4, 2)];

    const read = await readFramesFrom({ messageId: 'msg-1', fromSeq: 0 });

    assert({
      given: 'a reader whose cursor predates every surviving row',
      should: 'refuse to serve rather than start mid-message',
      actual: { frames: read.frames.length, truncated: read.truncated, empty: read.empty },
      expected: { frames: 0, truncated: true, empty: false },
    });
  });

  it('given no rows at all, reports empty', async () => {
    const read = await readFramesFrom({ messageId: 'msg-1', fromSeq: 0 });

    // `empty` is what lets a follower tell a RELEASED log (the stream ended and retention
    // deleted it) from a stream that simply has not flushed since the last tick.
    assert({
      given: 'a messageId the log holds nothing for',
      should: 'report empty, not truncated',
      actual: { empty: read.empty, truncated: read.truncated },
      expected: { empty: true, truncated: false },
    });
  });

  it('bounds one tick, resuming from where it stopped', async () => {
    // The FIRST tick starts at seq 0 and can face the whole log of a long reply. Bounded so
    // that read is spread across ticks rather than pulling tens of megabytes into memory at
    // once — the difference between a follower and an OOM after a fleet-wide reconnect.
    const big = 2 * 1024 * 1024;
    table = [row(0, 1, big), row(1, 1, big), row(2, 1, big)];

    const first = await readFramesFrom({ messageId: 'msg-1', fromSeq: 0 });
    const second = await readFramesFrom({ messageId: 'msg-1', fromSeq: first.nextSeq });

    assert({
      given: 'a log far larger than one tick\'s budget',
      should: 'stop inside the budget without reporting truncation, and continue on the next tick',
      actual: {
        first: deltas(first.frames),
        firstTruncated: first.truncated,
        second: deltas(second.frames),
      },
      expected: { first: ['f0'], firstTruncated: false, second: ['f1'] },
    });
  });

  // ── FAILURE MUST NOT LOOK LIKE A RELEASED LOG ───────────────────────────────────────────────

  it('given the cursor seek fails, reports neither frames nor emptiness', async () => {
    table = [row(0, 2)];
    seekError = new Error('db down');

    const read = await readFramesFrom({ messageId: 'msg-1', fromSeq: 0 });

    // `empty: false` on failure is load-bearing: a follower reads `empty` as "the log was
    // released", and a DB blip that said so would end every viewer's stream early.
    assert({
      given: 'a read that threw',
      should: 'answer a quiet tick, never "the log is gone"',
      actual: { frames: read.frames.length, nextSeq: read.nextSeq, empty: read.empty, truncated: read.truncated },
      expected: { frames: 0, nextSeq: 0, empty: false, truncated: false },
    });
  });

  it('given the range read fails, degrades the same way', async () => {
    table = [row(0, 2)];
    rangeError = new Error('db down');

    const read = await readFramesFrom({ messageId: 'msg-1', fromSeq: 0 });

    assert({
      given: 'a payload read that threw',
      should: 'answer a quiet tick',
      actual: { frames: read.frames.length, empty: read.empty },
      expected: { frames: 0, empty: false },
    });
  });

  it('scopes every read to the messageId asked for', async () => {
    table = [row(0, 2), { ...row(0, 2), messageId: 'msg-other' }];

    const read = await readFramesFrom({ messageId: 'msg-other', fromSeq: 0 });

    assert({
      given: 'two messages\' logs in the table',
      should: 'read only the one named',
      actual: read.frames.length,
      expected: 2,
    });
  });
});

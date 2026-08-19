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
/** Fails the metadata-shaped queries only (the emptiness probe and the index pass) — the seek
 *  itself succeeds, which is the one combination the two knobs above cannot express. */
let indexError: Error | null = null;
/**
 * Every query the module issued, in order — so a case can assert on WHAT WAS FETCHED rather
 * than only on what was returned. That distinction is the entire point of the byte budget: an
 * earlier version applied it while walking a result the driver had already materialized in
 * full, which bounded nothing.
 */
let issued: { kind: 'seek' | 'index' | 'payload'; cond: Cond; limit?: number; rows: number }[] = [];

const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }));

vi.mock('@pagespace/db/db', () => ({
  db: {
    select: (projection: Record<string, unknown>) => {
      // `max(from_seq)` — the containing-row seek. Distinguished by the marker the `max` mock
      // below returns, so the two selects cannot be confused for one another.
      const isSeek = (projection.fromSeq as { max?: unknown } | undefined)?.max !== undefined;
      const isPayload = 'frames' in projection;
      const kind = isSeek ? 'seek' as const : isPayload ? 'payload' as const : 'index' as const;

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
        if (indexError && !isPayload) throw indexError;
        if (seekError && !isPayload) throw seekError;
        return rows;
      };

      const record = (cond: Cond, limit: number | undefined, rows: unknown[]) => {
        issued.push({ kind, cond, limit, rows: rows.length });
        return rows;
      };

      // A query is consumed one of two ways: awaited DIRECTLY (the seek and the payload pass)
      // or through `.limit(n)` (the emptiness probe and the index pass). Execution is deferred
      // to whichever path consumes it — an eager base promise here would run the query a
      // second time as an orphan, and every mocked failure would surface once as the rejection
      // the case asserts on and once more as an unhandled one.
      const chain = (cond: Cond) => {
        const runRecord = (): unknown[] => record(cond, undefined, run(cond) as unknown[]);
        return {
          orderBy: () => ({
            then: (resolve: (rows: unknown) => unknown, reject?: (err: unknown) => unknown) =>
              Promise.resolve(null).then(runRecord).then(resolve, reject),
            limit: (n: number) => Promise.resolve(record(cond, n, (run(cond) as Row[]).slice(0, n))),
          }),
          // BOTH handlers forwarded. `await` calls `then(resolve, reject)`, so a thenable that
          // drops the second argument swallows every rejection and the await hangs forever —
          // which is what a failed-read case looks like from the outside: a 5s timeout, not a
          // failure.
          then: (resolve: (rows: unknown) => unknown, reject?: (err: unknown) => unknown) =>
            Promise.resolve(null).then(runRecord).then(resolve, reject),
        };
      };

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
  issued = [];
  seekError = null;
  rangeError = null;
  indexError = null;
});

/** Rows the PAYLOAD query actually pulled out of the database this tick. */
const payloadRowsFetched = (): number =>
  issued.filter((q) => q.kind === 'payload').reduce((n, q) => n + q.rows, 0);

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

  // ── THE BUDGET MUST BOUND THE QUERY, NOT THE LOOP ───────────────────────────────────────────
  //
  // An earlier version selected every row from the cursor onward and applied MAX_TICK_BYTES
  // while walking the result — which bounded nothing, because the driver had already
  // materialized and parsed the entire remaining log (up to the writer's 64 MB per-stream
  // ceiling) before any JavaScript ceiling could look at it. These cases assert on what was
  // FETCHED; the one below only asserts on what was returned, and passed against that version.

  it('fetches payload rows only up to the tick budget, not the whole remaining log', async () => {
    const big = 2 * 1024 * 1024;
    table = [row(0, 1, big), row(1, 1, big), row(2, 1, big), row(3, 1, big), row(4, 1, big)];

    await readFramesFrom({ messageId: 'msg-1', fromSeq: 0 });

    assert({
      given: 'a log far larger than one tick\'s budget',
      should: 'pull only the budgeted rows out of the database',
      actual: payloadRowsFetched(),
      expected: 1,
    });
  });

  it('caps the metadata read in SQL rather than in the walk', async () => {
    table = [row(0, 1), row(1, 1)];

    await readFramesFrom({ messageId: 'msg-1', fromSeq: 0 });

    // Three integers per row, so this is a formality against a pathological log — but it has to
    // be expressed as a LIMIT, in the statement, for the same reason the byte budget does.
    assert({
      given: 'the metadata pass',
      should: 'carry a row LIMIT',
      actual: issued.find((q) => q.kind === 'index')?.limit,
      expected: 512,
    });
  });

  it('given a tick with nothing new, never issues the payload query at all', async () => {
    table = [row(0, 3)];

    await readFramesFrom({ messageId: 'msg-1', fromSeq: 3 });

    // The common case on a stream inside a long tool call. Stopping after the metadata pass is
    // what makes the two-pass split cheaper than the single over-fetching query it replaced,
    // rather than merely safer.
    assert({
      given: 'a follower that is fully caught up',
      should: 'stop after the metadata pass',
      actual: issued.filter((q) => q.kind === 'payload').length,
      expected: 0,
    });
  });

  it('bounds the payload query by an upper seq, not just a lower one', async () => {
    table = [row(0, 1, 2 * 1024 * 1024), row(1, 1), row(2, 1)];

    await readFramesFrom({ messageId: 'msg-1', fromSeq: 0 });

    // Without the `<= lastWanted` half, the payload query is open-ended again and the budget
    // decided nothing.
    assert({
      given: 'a budget that admitted only the first row',
      should: 'ask the database for exactly that range',
      actual: issued.find((q) => q.kind === 'payload')?.cond.lte,
      expected: 0,
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

  it('given the index read fails after a successful seek, reports neither frames nor emptiness', async () => {
    table = [row(0, 2)];
    indexError = new Error('db down');

    const read = await readFramesFrom({ messageId: 'msg-1', fromSeq: 0 });

    // The METADATA pass — the query that decides how much to fetch. Its failure is a quiet
    // tick like every other failed read, and must never read as "the log was released".
    assert({
      given: 'a metadata read that threw after the seek succeeded',
      should: 'answer a quiet tick, never "the log is gone"',
      actual: { frames: read.frames.length, nextSeq: read.nextSeq, empty: read.empty, truncated: read.truncated },
      expected: { frames: 0, nextSeq: 0, empty: false, truncated: false },
    });
  });

  it('given the emptiness check fails, reports neither frames nor emptiness', async () => {
    table = [];
    indexError = new Error('db down');

    const read = await readFramesFrom({ messageId: 'msg-1', fromSeq: 0 });

    // The seek found no containing row, and deciding whether that means "released" or
    // "begins after the cursor" is itself a query — its failure is a quiet tick too.
    assert({
      given: 'an emptiness probe that threw',
      should: 'answer a quiet tick, never "the log is gone"',
      actual: { frames: read.frames.length, nextSeq: read.nextSeq, empty: read.empty, truncated: read.truncated },
      expected: { frames: 0, nextSeq: 0, empty: false, truncated: false },
    });
  });

  it('given the payload read fails, degrades the same way', async () => {
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

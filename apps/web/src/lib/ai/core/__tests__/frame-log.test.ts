import { describe, it, beforeEach, vi } from 'vitest';
import { assert } from './riteway';

const {
  mockInsertValues,
  mockDeleteWhere,
  mockSelectOrderBy,
  mockLoggerWarn,
} = vi.hoisted(() => ({
  mockInsertValues: vi.fn(),
  mockDeleteWhere: vi.fn(),
  mockSelectOrderBy: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

/**
 * `readFrames` runs TWO queries — a metadata pass that decides the prefix, then a payload pass
 * bounded by `from_seq <= lastWanted`. The mock therefore has to MODEL that predicate rather
 * than replay one canned array to both, or the payload pass would hand back rows the budget
 * and gap checks had already excluded and every truncation assertion would be vacuous.
 *
 * `mockSelectOrderBy` stays the single source of rows; the chain applies the bound.
 */
const lteBoundOf = (cond: unknown): number | null => {
  const parts = (cond as { conds?: unknown[] })?.conds ?? [cond];
  for (const part of parts) {
    const bound = (part as { lteValue?: number })?.lteValue;
    if (typeof bound === 'number') return bound;
  }
  return null;
};

vi.mock('@pagespace/db/db', () => ({
  db: {
    insert: vi.fn(() => ({ values: mockInsertValues })),
    delete: vi.fn(() => ({ where: mockDeleteWhere })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((cond: unknown) => ({
          orderBy: async () => {
            const rows = (await mockSelectOrderBy()) as { fromSeq: number }[];
            const bound = lteBoundOf(cond);
            return bound === null ? rows : rows.filter((r) => r.fromSeq <= bound);
          },
        })),
      })),
    })),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
  asc: vi.fn((field: unknown) => ({ asc: field })),
  and: vi.fn((...conds: unknown[]) => ({ conds })),
  lte: vi.fn((field: unknown, value: unknown) => ({ field, lteValue: value })),
}));

vi.mock('@pagespace/db/schema/ai-streams', () => ({
  aiStreamFrames: {
    messageId: 'ai_stream_frames.message_id',
    fromSeq: 'ai_stream_frames.from_seq',
    frameCount: 'ai_stream_frames.frame_count',
    frames: 'ai_stream_frames.frames',
    createdAt: 'ai_stream_frames.created_at',
  },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { ai: { info: vi.fn(), warn: mockLoggerWarn, error: vi.fn(), debug: vi.fn() } },
}));

import type { UIMessageChunk } from 'ai';
import { appendFrameBatch, deleteFrames, readFrames } from '../frame-log';

const chunk = (value: unknown): UIMessageChunk => value as UIMessageChunk;
const frameRow = (
  fromSeq: number,
  frames: unknown[],
  frameCount = frames.length,
  byteSize = JSON.stringify(frames).length,
) => ({
  fromSeq,
  frameCount,
  frames,
  byteSize,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertValues.mockResolvedValue(undefined);
  mockDeleteWhere.mockResolvedValue(undefined);
  mockSelectOrderBy.mockResolvedValue([]);
});

describe('appendFrameBatch', () => {
  const batch = {
    messageId: 'msg-1',
    conversationId: 'conv-1',
    fromSeq: 12,
    frames: [chunk({ type: 'text-delta', id: 't1', delta: 'hi' })],
  };

  it('writes the row the seq contract describes: [from_seq, from_seq + frame_count)', async () => {
    await appendFrameBatch(batch);

    const values = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    assert({
      given: 'a batch starting at seq 12 with one frame',
      should: 'record fromSeq and frameCount so the row covers exactly [12, 13)',
      actual: { fromSeq: values.fromSeq, frameCount: values.frameCount },
      expected: { fromSeq: 12, frameCount: 1 },
    });
  });

  it('measures byteSize EXACTLY, by serializing the batch', async () => {
    // The column exists to answer "how much durable storage is this stream using". The
    // channel's per-frame estimator is deliberately approximate (it reads `delta` directly
    // and charges an unmeasurable frame a flat megabyte), which is right for a hot-path
    // budget and wrong here.
    await appendFrameBatch(batch);

    const values = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    assert({
      given: 'a written batch',
      should: 'record the serialized size of the frames array itself',
      actual: values.byteSize,
      expected: Buffer.byteLength(JSON.stringify(batch.frames), 'utf8'),
    });
  });

  it('measures byteSize in UTF-8 BYTES, not UTF-16 code units', async () => {
    // `String.prototype.length` equals the byte count only for ASCII. A column named
    // `byte_size` that undercounts every non-English reply is a misleading storage metric,
    // and it is the number a future durable quota would be enforced from.
    const multibyte = {
      messageId: 'msg-1',
      conversationId: 'conv-1',
      fromSeq: 0,
      frames: [chunk({ type: 'text-delta', id: 't1', delta: '\u754c\ud83d\ude00\u00e9' })],
    };

    await appendFrameBatch(multibyte);

    const values = mockInsertValues.mock.calls[0][0] as Record<string, unknown>;
    const serialized = JSON.stringify(multibyte.frames);
    expect(values.byteSize).toBe(Buffer.byteLength(serialized, 'utf8'));
    // …and that is genuinely larger than the code-unit count, so this assertion has teeth.
    expect(values.byteSize as number).toBeGreaterThan(serialized.length);
  });

  it('given the insert throws, reports failure instead of taking down the generation', async () => {
    mockInsertValues.mockRejectedValue(new Error('connection reset'));

    const ok = await appendFrameBatch(batch);

    assert({
      given: 'a durability write that failed',
      should: 'return false and warn — a safety net must not be able to drop the acrobat',
      actual: { ok, warned: mockLoggerWarn.mock.calls.length },
      expected: { ok: false, warned: 1 },
    });
  });
});

describe('deleteFrames', () => {
  it('scopes the delete to the one messageId', async () => {
    await deleteFrames('msg-gone');

    assert({
      given: 'a release for one message',
      should: 'delete by that message_id and nothing wider',
      actual: mockDeleteWhere.mock.calls.map((c) => c[0]),
      expected: [{ field: 'ai_stream_frames.message_id', value: 'msg-gone' }],
    });
  });

  it('given the delete throws, reports failure rather than breaking the path mid-cleanup', async () => {
    mockDeleteWhere.mockRejectedValue(new Error('deadlock detected'));

    assert({
      given: 'a failed delete',
      should: 'return false — the retention backstop reclaims what this left behind',
      actual: await deleteFrames('msg-1'),
      expected: false,
    });
  });
});

describe('readFrames', () => {
  it('given rows in seq order, returns one flat frame list', async () => {
    mockSelectOrderBy.mockResolvedValue([
      frameRow(0, [{ type: 'text-start', id: 't1' }]),
      frameRow(1, [{ type: 'text-delta', id: 't1', delta: 'a' }, { type: 'text-delta', id: 't1', delta: 'b' }]),
      frameRow(3, [{ type: 'text-end', id: 't1' }]),
    ]);

    assert({
      given: 'three contiguous batches',
      should: 'flatten them into the frame sequence the generation produced',
      actual: (await readFrames('msg-1'))?.map((f) => f.type),
      expected: ['text-start', 'text-delta', 'text-delta', 'text-end'],
    });
  });

  it('given no rows, returns null rather than an empty list', async () => {
    // The distinction is load-bearing: `[]` reads as "this stream produced nothing", which
    // would materialize emptiness over a `parts` snapshot that had real content.
    assert({
      given: 'a messageId with no frame log',
      should: 'return null so the caller falls back to the parts snapshot',
      actual: await readFrames('msg-1'),
      expected: null,
    });
  });

  it('given a gap, truncates at the hole rather than folding across it', async () => {
    mockSelectOrderBy.mockResolvedValue([
      frameRow(0, [{ type: 'text-start', id: 't1' }]),
      frameRow(1, [{ type: 'text-delta', id: 't1', delta: 'kept' }]),
      // seq 2 never landed.
      frameRow(3, [{ type: 'text-delta', id: 't1', delta: 'dropped' }]),
    ]);

    assert({
      given: 'a log missing one seq in the middle',
      should: 'return only the contiguous prefix — a prefix is honest, a splice is confidently wrong',
      actual: (await readFrames('msg-1'))?.length,
      expected: 2,
    });
  });

  it('given a first row that does not start at seq 0, returns null', async () => {
    mockSelectOrderBy.mockResolvedValue([frameRow(5, [{ type: 'text-delta', id: 't1', delta: 'tail' }])]);

    assert({
      given: 'a log whose head was swept, leaving an orphan tail',
      should: 'return null rather than a headless message',
      actual: await readFrames('msg-1'),
      expected: null,
    });
  });

  it('advances by the RECORDED frame_count, so a count that disagrees with the payload shows up as a gap', async () => {
    // Trusting the column is what turns a corrupt row into a visible truncation instead of
    // silently shifting every later row's seq by the difference.
    mockSelectOrderBy.mockResolvedValue([
      frameRow(0, [{ type: 'text-start', id: 't1' }], 2),
      frameRow(1, [{ type: 'text-delta', id: 't1', delta: 'x' }]),
    ]);

    assert({
      given: 'a row claiming 2 frames but carrying 1',
      should: 'expect the next row at seq 2, find seq 1, and truncate',
      actual: (await readFrames('msg-1'))?.map((f) => f.type),
      expected: ['text-start'],
    });
  });

  it('given a log past the read budget, returns the prefix rather than materializing all of it', async () => {
    // The callers are batch loops: a mass recovery fans `materializeInterruptedStream` out with
    // `Promise.all` over every dead row an instance left behind. Unbounded, peak memory is
    // dozens x the per-stream durable budget — one dead instance becoming two.
    const MB = 1024 * 1024;
    mockSelectOrderBy.mockResolvedValue([
      frameRow(0, [{ type: 'text-start', id: 't1' }], 1, 10 * MB),
      frameRow(1, [{ type: 'text-delta', id: 't1', delta: 'kept' }], 1, 10 * MB),
      frameRow(2, [{ type: 'text-delta', id: 't1', delta: 'also kept' }], 1, 10 * MB),
      // The budget is already spent by the time this row is reached.
      frameRow(3, [{ type: 'text-delta', id: 't1', delta: 'past the budget' }], 1, 10 * MB),
      frameRow(4, [{ type: 'text-delta', id: 't1', delta: 'also past it' }], 1, 10 * MB),
    ]);

    assert({
      given: 'a log whose recorded size runs past the read budget',
      should: 'stop at the budget and return the contiguous prefix read so far',
      actual: (await readFrames('msg-1'))?.length,
      expected: 3,
    });
  });

  it('given an ordinary log, does not truncate — the budget must not bite a normal reply', async () => {
    mockSelectOrderBy.mockResolvedValue([
      frameRow(0, [{ type: 'text-start', id: 't1' }]),
      frameRow(1, [{ type: 'text-delta', id: 't1', delta: 'a normal reply' }]),
    ]);

    assert({
      given: 'a log of ordinary size',
      should: 'return every frame',
      actual: (await readFrames('msg-1'))?.length,
      expected: 2,
    });
  });

  it('given the read throws, returns null so a recovery degrades to the parts snapshot', async () => {
    mockSelectOrderBy.mockRejectedValue(new Error('frames table unreachable'));

    assert({
      given: 'a frame-log read that failed',
      should: 'return null rather than failing a recovery that had a usable snapshot all along',
      actual: await readFrames('msg-1'),
      expected: null,
    });
  });
});

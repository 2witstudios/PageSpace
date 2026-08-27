/**
 * Tests for the mislabelled-`contentMode` backfill's imperative shell.
 * Classification itself is unit-tested in document-content-format.test.ts;
 * here we verify the runner's loop: dry-run writes nothing, apply corrects
 * only tagless html-mode pages and bumps revision, a page that fails to
 * classify confidently is skipped and reported rather than guessed at, a
 * concurrently-modified row is skipped rather than clobbered, pagination
 * advances and terminates, onBatchCorrected fires per batch in apply mode
 * only, updatedAt is pinned, and revert flips exactly the given
 * (id, revisionAfterApply) pairs back — never a page edited since.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { gtCursors, classifyMock } = vi.hoisted(() => ({
  gtCursors: [] as unknown[],
  classifyMock: vi.fn(),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: {
    id: 'id',
    type: 'type',
    content: 'content',
    contentMode: 'contentMode',
    updatedAt: 'updatedAt',
    revision: 'revision',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: (col: unknown, value: unknown) => ({ eq: [col, value] }),
  gt: (_col: unknown, cursor: unknown) => {
    gtCursors.push(cursor);
    return {};
  },
  asc: () => ({}),
  and: (...conds: unknown[]) => ({ and: conds }),
  or: (...conds: unknown[]) => ({ or: conds }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ __sql: true, strings, values }),
}));
vi.mock('../document-content-format', async () => {
  const actual = await vi.importActual<typeof import('../document-content-format')>('../document-content-format');
  // Delegate to the real classifier by default; individual tests override
  // with mockReturnValueOnce. Wired here (not in a beforeEach) so nothing in
  // the test file needs its own reference to the real, unmocked function.
  classifyMock.mockImplementation(actual.classifyDocumentContent);
  return { ...actual, classifyDocumentContent: classifyMock };
});

import {
  planAndApplyBackfill,
  revertBackfill,
  parseBackfillArgs,
  type BackfillDb,
  type CorrectedPage,
} from '../content-mode-backfill';

/** Chainable select stub terminating on .limit(); returns successive batches. */
function selectReturning(batches: unknown[][]) {
  let call = 0;
  return vi.fn(() => {
    const rows = batches[call] ?? [];
    call += 1;
    const stub: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy']) stub[m] = () => stub;
    stub['limit'] = () => Promise.resolve(rows);
    return stub;
  });
}

/**
 * Chainable update stub for the apply-mode compare-and-swap: `.returning()`
 * resolves with one row (a fresh, incrementing `revision`, proving the write
 * used the SQL increment expression rather than a static value) when
 * `succeeds`, or an empty array (the concurrent-modification case) when not.
 * The row's `id` is read back out of the mocked `and(eq(pages.id, ...), ...)`
 * WHERE condition so it always matches the page actually being updated.
 */
function captureUpdate({ succeeds = true }: { succeeds?: boolean } = {}) {
  const sets: Array<Record<string, unknown>> = [];
  let revision = 100;
  const update = vi.fn(() => ({
    set: (v: Record<string, unknown>) => {
      sets.push(v);
      return {
        where: (cond: { and: Array<{ eq: [unknown, unknown] }> }) => ({
          returning: () => {
            if (!succeeds) return Promise.resolve([]);
            revision += 1;
            return Promise.resolve([{ id: cond.and[0].eq[1], revision }]);
          },
        }),
      };
    },
  }));
  return { update, sets };
}

function fakeDb(select: ReturnType<typeof selectReturning>, update: ReturnType<typeof captureUpdate>['update']) {
  return { select, update } as unknown as BackfillDb;
}

const priorUpdatedAt = new Date('2026-01-15T12:00:00Z');
const markdownPage = (id: string, revision = 5) => ({
  id,
  content: '# Heading\n\nSome *emphasis* and a list:\n\n- one\n- two',
  contentMode: 'html' as const,
  updatedAt: priorUpdatedAt,
  revision,
});
const htmlPage = (id: string) => ({
  id,
  content: '<p>real <strong>html</strong></p>',
  contentMode: 'html' as const,
  updatedAt: priorUpdatedAt,
  revision: 5,
});
const emptyPage = (id: string) => ({
  id,
  content: '   ',
  contentMode: 'html' as const,
  updatedAt: priorUpdatedAt,
  revision: 5,
});

beforeEach(() => {
  gtCursors.length = 0;
});

describe('planAndApplyBackfill', () => {
  it('dry run: reports tagless html-mode pages as to-be-corrected (previewing the post-apply revision) and writes nothing', async () => {
    const select = selectReturning([[markdownPage('p1'), htmlPage('p2'), emptyPage('p3')], []]);
    const { update, sets } = captureUpdate();
    const result = await planAndApplyBackfill(fakeDb(select, update), { apply: false });

    expect(result).toEqual({
      scanned: 3,
      corrected: [{ id: 'p1', revisionAfterApply: 6 }],
      skippedUnparseable: [],
      skippedConcurrentModification: [],
    });
    expect(update).not.toHaveBeenCalled();
    expect(sets).toHaveLength(0);
  });

  it('apply: corrects contentMode to markdown for a tagless page, bumps revision via a SQL expression (not a static value), pins updatedAt, and leaves content untouched', async () => {
    const select = selectReturning([[markdownPage('p1')], []]);
    const { update, sets } = captureUpdate();
    const result = await planAndApplyBackfill(fakeDb(select, update), { apply: true });

    expect(result.corrected).toEqual([{ id: 'p1', revisionAfterApply: 101 }]);
    expect(sets).toHaveLength(1);
    expect(sets[0].contentMode).toBe('markdown');
    expect(sets[0].updatedAt).toBe(priorUpdatedAt);
    expect(sets[0].content).toBeUndefined();
    expect(sets[0].revision).toEqual(expect.objectContaining({ __sql: true }));
  });

  it('leaves genuinely html-mode pages alone', async () => {
    const select = selectReturning([[htmlPage('p1')], []]);
    const { update } = captureUpdate();
    const result = await planAndApplyBackfill(fakeDb(select, update), { apply: true });

    expect(result).toEqual({ scanned: 1, corrected: [], skippedUnparseable: [], skippedConcurrentModification: [] });
    expect(update).not.toHaveBeenCalled();
  });

  it('leaves empty pages alone', async () => {
    const select = selectReturning([[emptyPage('p1')], []]);
    const { update } = captureUpdate();
    const result = await planAndApplyBackfill(fakeDb(select, update), { apply: true });

    expect(result.corrected).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });

  it('a page that cannot be classified confidently is skipped and reported, never guessed at', async () => {
    classifyMock.mockReturnValueOnce({ format: 'unknown', confident: false, reason: 'RangeError' });
    const select = selectReturning([[markdownPage('p1')], []]);
    const { update } = captureUpdate();
    const result = await planAndApplyBackfill(fakeDb(select, update), { apply: true });

    expect(result).toEqual({
      scanned: 1,
      corrected: [],
      skippedUnparseable: [{ id: 'p1', reason: 'RangeError' }],
      skippedConcurrentModification: [],
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('a row modified concurrently between select and write is skipped, not clobbered', async () => {
    const select = selectReturning([[markdownPage('p1')], []]);
    const { update } = captureUpdate({ succeeds: false });
    const result = await planAndApplyBackfill(fakeDb(select, update), { apply: true });

    expect(result).toEqual({
      scanned: 1,
      corrected: [],
      skippedUnparseable: [],
      skippedConcurrentModification: ['p1'],
    });
  });

  it('paginates by advancing the ascending-id cursor to each batch\'s last id and terminates', async () => {
    const select = selectReturning([[markdownPage('p1')], [markdownPage('p2')], []]);
    const { update, sets } = captureUpdate();
    const result = await planAndApplyBackfill(fakeDb(select, update), { apply: true, batchSize: 1 });

    expect(result.corrected).toEqual([
      { id: 'p1', revisionAfterApply: 101 },
      { id: 'p2', revisionAfterApply: 102 },
    ]);
    expect(sets).toHaveLength(2);
    expect(select).toHaveBeenCalledTimes(3);
    expect(gtCursors).toEqual(['p1', 'p2']);
  });

  it('invokes onBatchCorrected once per batch, with only that batch\'s corrected pages, so a crash mid-run leaves a manifest of everything already committed', async () => {
    const select = selectReturning([[markdownPage('p1')], [markdownPage('p2'), htmlPage('p3')], []]);
    const { update } = captureUpdate();
    const onBatchCorrected = vi.fn();
    await planAndApplyBackfill(fakeDb(select, update), { apply: true, batchSize: 2, onBatchCorrected });

    expect(onBatchCorrected).toHaveBeenCalledTimes(2);
    expect(onBatchCorrected).toHaveBeenNthCalledWith(1, [{ id: 'p1', revisionAfterApply: 101 }]);
    expect(onBatchCorrected).toHaveBeenNthCalledWith(2, [{ id: 'p2', revisionAfterApply: 102 }]);
  });

  it('never invokes onBatchCorrected in dry-run mode — nothing was written', async () => {
    const select = selectReturning([[markdownPage('p1')], []]);
    const { update } = captureUpdate();
    const onBatchCorrected = vi.fn();
    await planAndApplyBackfill(fakeDb(select, update), { apply: false, onBatchCorrected });

    expect(onBatchCorrected).not.toHaveBeenCalled();
  });

  it('does not invoke onBatchCorrected for a batch with no mislabelled pages', async () => {
    const select = selectReturning([[htmlPage('p1')], []]);
    const { update } = captureUpdate();
    const onBatchCorrected = vi.fn();
    await planAndApplyBackfill(fakeDb(select, update), { apply: true, onBatchCorrected });

    expect(onBatchCorrected).not.toHaveBeenCalled();
  });

  it('does not invoke onBatchCorrected when a mislabelled batch corrects nothing (every write lost the compare-and-swap)', async () => {
    const select = selectReturning([[markdownPage('p1')], []]);
    const { update } = captureUpdate({ succeeds: false });
    const onBatchCorrected = vi.fn();
    await planAndApplyBackfill(fakeDb(select, update), { apply: true, onBatchCorrected });

    expect(onBatchCorrected).not.toHaveBeenCalled();
  });
});

/**
 * Chainable batched-update stub for revert: `.where()` captures the
 * condition it was called with (so a test can assert the per-row revision
 * pairing was actually built), and `.returning()` resolves with the rows the
 * test says the WHERE clause matched.
 */
function captureBatchedUpdate(returnedIds: string[]) {
  const sets: Array<Record<string, unknown>> = [];
  const whereConditions: unknown[] = [];
  const update = vi.fn(() => ({
    set: (v: Record<string, unknown>) => {
      sets.push(v);
      return {
        where: (cond: unknown) => {
          whereConditions.push(cond);
          return { returning: () => Promise.resolve(returnedIds.map((id) => ({ id }))) };
        },
      };
    },
  }));
  return { update, sets, whereConditions };
}

const correction = (id: string, revisionAfterApply: number): CorrectedPage => ({ id, revisionAfterApply });

describe('revertBackfill', () => {
  it('flips the given pages back to html when still markdown at the recorded revision, in one batched update, bumping revision again', async () => {
    const { update, sets } = captureBatchedUpdate(['p1', 'p2']);
    const result = await revertBackfill(
      { update } as unknown as BackfillDb,
      [correction('p1', 6), correction('p2', 9)],
    );
    expect(result).toEqual({ attempted: 2, reverted: ['p1', 'p2'], skippedAlreadyChanged: [] });
    expect(update).toHaveBeenCalledTimes(1);
    expect(sets[0].contentMode).toBe('html');
    expect(sets[0].revision).toEqual(expect.objectContaining({ __sql: true }));
  });

  it('builds the WHERE clause as a per-row (id, revision) pairing, not a cross-product of ids and revisions', async () => {
    const stub = captureBatchedUpdate(['p1']);
    await revertBackfill({ update: stub.update } as unknown as BackfillDb, [correction('p1', 6), correction('p2', 9)]);

    expect(stub.whereConditions).toHaveLength(1);
    const [cond] = stub.whereConditions as [{ and: [{ eq: [unknown, string] }, { or: Array<{ and: unknown[] }> }] }];
    expect(cond.and[0].eq).toEqual(['contentMode', 'markdown']);
    const orBranches = cond.and[1].or;
    expect(orBranches).toHaveLength(2);
    expect((orBranches[0] as { and: Array<{ eq: unknown[] }> }).and).toEqual([
      { eq: ['id', 'p1'] },
      { eq: ['revision', 6] },
    ]);
    expect((orBranches[1] as { and: Array<{ eq: unknown[] }> }).and).toEqual([
      { eq: ['id', 'p2'] },
      { eq: ['revision', 9] },
    ]);
  });

  it('skips a page no longer at the recorded revision — edited since the backfill — rather than discarding that edit', async () => {
    const { update } = captureBatchedUpdate([]);
    const result = await revertBackfill({ update } as unknown as BackfillDb, [correction('p1', 6)]);
    expect(result).toEqual({ attempted: 1, reverted: [], skippedAlreadyChanged: ['p1'] });
  });

  it('reports a mix of reverted and already-changed pages from one batch', async () => {
    const { update } = captureBatchedUpdate(['p1']);
    const result = await revertBackfill({ update } as unknown as BackfillDb, [correction('p1', 6), correction('p2', 9)]);
    expect(result).toEqual({ attempted: 2, reverted: ['p1'], skippedAlreadyChanged: ['p2'] });
  });

  it('is a no-op for an empty list, without querying the database', async () => {
    const { update } = captureBatchedUpdate([]);
    const result = await revertBackfill({ update } as unknown as BackfillDb, []);
    expect(result).toEqual({ attempted: 0, reverted: [], skippedAlreadyChanged: [] });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('parseBackfillArgs', () => {
  it('defaults to dry-run', () => {
    expect(parseBackfillArgs([])).toEqual({ ok: true, args: { mode: 'dry-run' } });
  });

  it('refuses --apply without --out: the correction must stay reversible', () => {
    const result = parseBackfillArgs(['--apply']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('--out');
  });

  it('accepts --apply --out <path>', () => {
    expect(parseBackfillArgs(['--apply', '--out', 'ids.json'])).toEqual({
      ok: true,
      args: { mode: 'apply', outPath: 'ids.json' },
    });
  });

  it('accepts --revert <path>', () => {
    expect(parseBackfillArgs(['--revert', 'ids.json'])).toEqual({
      ok: true,
      args: { mode: 'revert', revertPath: 'ids.json' },
    });
  });

  it('refuses --revert without a path', () => {
    const result = parseBackfillArgs(['--revert']);
    expect(result.ok).toBe(false);
  });

  it('refuses --apply and --revert together', () => {
    const result = parseBackfillArgs(['--apply', '--out', 'x.json', '--revert', 'y.json']);
    expect(result.ok).toBe(false);
  });
});

/**
 * Tests for the mislabelled-`contentMode` backfill's imperative shell.
 * Classification itself is unit-tested in document-content-format.test.ts;
 * here we verify the runner's loop: dry-run writes nothing, apply corrects
 * only tagless html-mode pages, a page that fails to classify confidently is
 * skipped and reported rather than guessed at, a concurrently-modified row
 * is skipped rather than clobbered, pagination advances and terminates,
 * updatedAt is pinned, and revert flips exactly the given ids back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { gtCursors, classifyMock } = vi.hoisted(() => ({
  gtCursors: [] as unknown[],
  classifyMock: vi.fn(),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', type: 'type', content: 'content', contentMode: 'contentMode', updatedAt: 'updatedAt' },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: (col: unknown, value: unknown) => ({ eq: [col, value] }),
  gt: (_col: unknown, cursor: unknown) => {
    gtCursors.push(cursor);
    return {};
  },
  asc: () => ({}),
  and: (...conds: unknown[]) => ({ and: conds }),
  inArray: (col: unknown, values: unknown) => ({ inArray: [col, values] }),
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

function captureUpdate({ rowCount = 1 }: { rowCount?: number } = {}) {
  const sets: Array<Record<string, unknown>> = [];
  const update = vi.fn(() => ({
    set: (v: Record<string, unknown>) => {
      sets.push(v);
      return { where: () => Promise.resolve({ rowCount }) };
    },
  }));
  return { update, sets };
}

function fakeDb(select: ReturnType<typeof selectReturning>, update: ReturnType<typeof captureUpdate>['update']) {
  return { select, update } as unknown as BackfillDb;
}

const priorUpdatedAt = new Date('2026-01-15T12:00:00Z');
const markdownPage = (id: string) => ({
  id,
  content: '# Heading\n\nSome *emphasis* and a list:\n\n- one\n- two',
  contentMode: 'html' as const,
  updatedAt: priorUpdatedAt,
});
const htmlPage = (id: string) => ({
  id,
  content: '<p>real <strong>html</strong></p>',
  contentMode: 'html' as const,
  updatedAt: priorUpdatedAt,
});
const emptyPage = (id: string) => ({ id, content: '   ', contentMode: 'html' as const, updatedAt: priorUpdatedAt });

beforeEach(() => {
  gtCursors.length = 0;
});

describe('planAndApplyBackfill', () => {
  it('dry run: reports tagless html-mode pages as to-be-corrected and writes nothing', async () => {
    const select = selectReturning([[markdownPage('p1'), htmlPage('p2'), emptyPage('p3')], []]);
    const { update, sets } = captureUpdate();
    const result = await planAndApplyBackfill(fakeDb(select, update), { apply: false });

    expect(result).toEqual({
      scanned: 3,
      corrected: ['p1'],
      skippedUnparseable: [],
      skippedConcurrentModification: [],
    });
    expect(update).not.toHaveBeenCalled();
    expect(sets).toHaveLength(0);
  });

  it('apply: corrects contentMode to markdown for a tagless page, pinning updatedAt, leaving content untouched', async () => {
    const select = selectReturning([[markdownPage('p1')], []]);
    const { update, sets } = captureUpdate();
    const result = await planAndApplyBackfill(fakeDb(select, update), { apply: true });

    expect(result.corrected).toEqual(['p1']);
    expect(sets).toHaveLength(1);
    expect(sets[0].contentMode).toBe('markdown');
    expect(sets[0].updatedAt).toBe(priorUpdatedAt);
    expect(sets[0].content).toBeUndefined();
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
    const { update } = captureUpdate({ rowCount: 0 });
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

    expect(result.corrected).toEqual(['p1', 'p2']);
    expect(sets).toHaveLength(2);
    expect(select).toHaveBeenCalledTimes(3);
    expect(gtCursors).toEqual(['p1', 'p2']);
  });
});

/** Batched update stub: `.returning()` resolves with the rows the WHERE clause matched. */
function captureBatchedUpdate(returnedIds: string[]) {
  const sets: Array<Record<string, unknown>> = [];
  const update = vi.fn(() => ({
    set: (v: Record<string, unknown>) => {
      sets.push(v);
      return { where: () => ({ returning: () => Promise.resolve(returnedIds.map((id) => ({ id }))) }) };
    },
  }));
  return { update, sets };
}

describe('revertBackfill', () => {
  it('flips the given ids back to html when still markdown, in one batched update', async () => {
    const { update } = captureBatchedUpdate(['p1', 'p2']);
    const result = await revertBackfill({ update } as unknown as BackfillDb, ['p1', 'p2']);
    expect(result).toEqual({ attempted: 2, reverted: ['p1', 'p2'], skippedAlreadyChanged: [] });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('skips ids no longer contentMode=markdown rather than forcing them', async () => {
    const { update } = captureBatchedUpdate([]);
    const result = await revertBackfill({ update } as unknown as BackfillDb, ['p1']);
    expect(result).toEqual({ attempted: 1, reverted: [], skippedAlreadyChanged: ['p1'] });
  });

  it('reports a mix of reverted and already-changed ids from one batch', async () => {
    const { update } = captureBatchedUpdate(['p1']);
    const result = await revertBackfill({ update } as unknown as BackfillDb, ['p1', 'p2']);
    expect(result).toEqual({ attempted: 2, reverted: ['p1'], skippedAlreadyChanged: ['p2'] });
  });

  it('is a no-op for an empty id list, without querying the database', async () => {
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

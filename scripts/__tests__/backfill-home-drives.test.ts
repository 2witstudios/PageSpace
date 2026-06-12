import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeHomeBackfillInserts, type UserBackfillData } from '../lib/home-drive-backfill';

// ─── DB mock setup (hoisted before imports) ──────────────────────────────────

const { selectMock, insertMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { select: selectMock, insert: insertMock },
}));

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id' },
}));

vi.mock('@pagespace/db/schema/core', () => ({
  drives: {
    id: 'id',
    ownerId: 'ownerId',
    kind: 'kind',
    slug: 'slug',
    name: 'name',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  sql: Object.assign(() => ({}), { raw: () => ({}) }),
  eq: () => ({}),
  and: () => ({}),
  gt: () => ({}),
  asc: () => ({}),
  inArray: () => ({}),
}));

// @paralleldrive/cuid2 lives in the bun package cache, not in node_modules/
// that Vite sees — mock it so the forked vitest process can import the script.
vi.mock('@paralleldrive/cuid2', () => ({
  createId: () => 'test-cuid-id',
}));

import { backfill } from '../backfill-home-drives';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A chainable + directly-awaitable stub.
 * - `.limit()` terminates the paginated user query.
 * - Direct await (thenable) handles the slug query (no LIMIT).
 * - All intermediate chain methods return the same stub.
 */
function makeChain(rows: unknown[]) {
  const stub: Record<string, unknown> = {};
  for (const m of ['from', 'leftJoin', 'where', 'orderBy']) stub[m] = () => stub;
  stub['limit'] = () => Promise.resolve(rows);
  stub['then'] = (resolve: (r: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(rows).then(resolve, reject);
  return stub;
}

/**
 * Set up the select mock for one backfill loop iteration.
 *
 * - Call 1 (paginated users + home-drive LEFT JOIN) → batchRows
 * - Call 2 (slug lookup for users needing Home) → slugRows (live mode only)
 * - Subsequent calls → [] (empty batch terminates the cursor loop)
 *
 * mockReset() in beforeEach clears both the one-time queue and the default,
 * so each test starts from a clean slate.
 */
function setupSelect(batchRows: unknown[], slugRows: unknown[] = []) {
  // Fallback default: empty batch → loop terminates cleanly after one iteration
  selectMock.mockReturnValue(makeChain([]));
  selectMock.mockReturnValueOnce(makeChain(batchRows));
  selectMock.mockReturnValueOnce(makeChain(slugRows));
}

/**
 * Set up a chainable insert mock that supports .values().onConflictDoNothing().returning().
 * writtenRows controls what .returning() resolves to — this is the count that
 * `backfill` uses for `inserted` in live mode (only actually-written rows).
 */
function setupInsert(writtenRows: Array<{ id: string }> = [{ id: 'test-cuid-id' }]) {
  const returningSpy = vi.fn().mockResolvedValue(writtenRows);
  const onConflictSpy = vi.fn().mockReturnValue({ returning: returningSpy });
  const valuesSpy = vi.fn().mockReturnValue({ onConflictDoNothing: onConflictSpy });
  insertMock.mockReturnValue({ values: valuesSpy });
  return { valuesSpy, onConflictSpy, returningSpy };
}

// ─── Pure-function tests (no DB, no mocks needed) ────────────────────────────

describe('computeHomeBackfillInserts', () => {
  it('returns [] for an empty batch', () => {
    expect(computeHomeBackfillInserts([])).toEqual([]);
  });

  it('skips users who already have a Home drive', () => {
    const users: UserBackfillData[] = [
      { userId: 'user-1', hasHome: true, existingSlugs: ['home'] },
    ];
    expect(computeHomeBackfillInserts(users)).toEqual([]);
  });

  it('returns a row for a user with no Home drive and no slug collision', () => {
    const users: UserBackfillData[] = [
      { userId: 'user-1', hasHome: false, existingSlugs: [] },
    ];
    expect(computeHomeBackfillInserts(users)).toEqual([
      { ownerId: 'user-1', slug: 'home', name: 'Home' },
    ]);
  });

  it('applies -2 suffix when slug "home" is already taken', () => {
    const users: UserBackfillData[] = [
      { userId: 'user-1', hasHome: false, existingSlugs: ['home'] },
    ];
    expect(computeHomeBackfillInserts(users)).toEqual([
      { ownerId: 'user-1', slug: 'home-2', name: 'Home' },
    ]);
  });

  it('increments suffix past consecutive taken slugs', () => {
    const users: UserBackfillData[] = [
      { userId: 'user-1', hasHome: false, existingSlugs: ['home', 'home-2', 'home-3'] },
    ];
    expect(computeHomeBackfillInserts(users)).toEqual([
      { ownerId: 'user-1', slug: 'home-4', name: 'Home' },
    ]);
  });

  it('finds the lowest free suffix even when gaps exist', () => {
    const users: UserBackfillData[] = [
      { userId: 'user-1', hasHome: false, existingSlugs: ['home', 'home-3'] },
    ];
    expect(computeHomeBackfillInserts(users)).toEqual([
      { ownerId: 'user-1', slug: 'home-2', name: 'Home' },
    ]);
  });

  it('processes a mixed batch, returning rows only for users lacking Home', () => {
    const users: UserBackfillData[] = [
      { userId: 'already', hasHome: true, existingSlugs: ['home'] },
      { userId: 'clean', hasHome: false, existingSlugs: [] },
      { userId: 'collision', hasHome: false, existingSlugs: ['home', 'work'] },
    ];
    const result = computeHomeBackfillInserts(users);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ ownerId: 'clean', slug: 'home', name: 'Home' });
    expect(result[1]).toEqual({ ownerId: 'collision', slug: 'home-2', name: 'Home' });
  });

  it('preserves order of users needing Home in the output', () => {
    const users: UserBackfillData[] = [
      { userId: 'a', hasHome: false, existingSlugs: [] },
      { userId: 'b', hasHome: false, existingSlugs: [] },
      { userId: 'c', hasHome: false, existingSlugs: [] },
    ];
    expect(computeHomeBackfillInserts(users).map((r) => r.ownerId)).toEqual(['a', 'b', 'c']);
  });
});

// ─── Script-level tests (mocked DB) ──────────────────────────────────────────

describe('backfill (dry-run)', () => {
  beforeEach(() => {
    selectMock.mockReset();
    insertMock.mockReset();
  });

  it('reports the projected count of users lacking Home and inserts nothing', async () => {
    // batch: user-1 has no Home (projected insert), user-2 already has one (skipped)
    setupSelect([
      { userId: 'user-1', homeDriveId: null },
      { userId: 'user-2', homeDriveId: 'drive-home-2' },
    ]);

    const { inserted, skipped } = await backfill(true);

    // inserted = projected count (1 user lacks Home); skipped = already-have-Home count
    expect(inserted).toBe(1);
    expect(skipped).toBe(1);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('returns zero counts for an empty database', async () => {
    setupSelect([]);

    const { inserted, skipped } = await backfill(true);

    expect(inserted).toBe(0);
    expect(skipped).toBe(0);
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('backfill (live)', () => {
  beforeEach(() => {
    selectMock.mockReset();
    insertMock.mockReset();
  });

  it('is idempotent: skips users who already have a Home drive', async () => {
    setupSelect([{ userId: 'user-1', homeDriveId: 'existing-home' }]);

    const { inserted, skipped } = await backfill(false);

    expect(insertMock).not.toHaveBeenCalled();
    expect(inserted).toBe(0);
    expect(skipped).toBe(1);
  });

  it('inserts Home drives for users that are missing them', async () => {
    setupSelect(
      [{ userId: 'user-needs-home', homeDriveId: null }],
      [], // no existing slugs for this user
    );
    const { valuesSpy, onConflictSpy } = setupInsert([{ id: 'test-cuid-id' }]);

    const { inserted, skipped } = await backfill(false);

    expect(insertMock).toHaveBeenCalledTimes(1);
    // inserted reflects .returning() count — only actually-written rows
    expect(inserted).toBe(1);
    expect(skipped).toBe(0);

    // Verify kind: 'HOME' is included in the inserted rows
    const insertedRows = valuesSpy.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(insertedRows[0]).toMatchObject({ kind: 'HOME', ownerId: 'user-needs-home', name: 'Home' });

    // Verify conflict is swallowed via onConflictDoNothing (partial-unique-index guard)
    expect(onConflictSpy).toHaveBeenCalledTimes(1);
    const callArg = onConflictSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(callArg).toHaveProperty('target');
    expect(callArg).toHaveProperty('targetWhere');
  });

  it('swallows a conflict via onConflictDoNothing: counts only actually-written rows', async () => {
    // Lazy provisioning raced and created the Home drive — returning() returns [] (conflict)
    setupSelect(
      [{ userId: 'user-race', homeDriveId: null }],
      [],
    );
    const { onConflictSpy } = setupInsert([]); // returning empty = conflict was skipped

    const { inserted } = await backfill(false);

    expect(onConflictSpy).toHaveBeenCalledTimes(1);
    // inserted = 0 because the race was won by lazy provisioning (row not written)
    expect(inserted).toBe(0);
  });

  it('returns zero counts for an empty database (idempotent second run)', async () => {
    setupSelect([]);

    const { inserted, skipped } = await backfill(false);

    expect(insertMock).not.toHaveBeenCalled();
    expect(inserted).toBe(0);
    expect(skipped).toBe(0);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db', () => ({
  db: { select: vi.fn() },
  pages: { id: 'id', driveId: 'driveId', isTrashed: 'isTrashed' },
  drives: { id: 'id', ownerId: 'ownerId' },
  driveMembers: {
    id: 'id',
    driveId: 'driveId',
    userId: 'userId',
    role: 'role',
    acceptedAt: 'acceptedAt',
  },
  pagePermissions: {
    pageId: 'pageId',
    userId: 'userId',
    canView: 'canView',
    canEdit: 'canEdit',
    canShare: 'canShare',
    canDelete: 'canDelete',
    expiresAt: 'expiresAt',
  },
  eq: vi.fn((_a: unknown, _b: unknown) => 'eq'),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  isNull: vi.fn((a: unknown) => ({ isNull: a })),
  isNotNull: vi.fn((a: unknown) => ({ isNotNull: a })),
  gt: vi.fn((a: unknown, b: unknown) => ({ gt: { a, b } })),
  inArray: vi.fn((a: unknown, b: unknown) => ({ inArray: { a, b } })),
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

vi.mock('../../validators', () => ({
  parseUserId: vi.fn(),
  parsePageId: vi.fn(),
}));

import { getBatchPagePermissions } from '../permissions';
import { db, isNotNull } from '@pagespace/db';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const USER = 'user_abc';

interface Row {
  pageId: string;
  isTrashed: boolean;
  driveOwnerId: string | null;
  adminMemberId: string | null;
  explicitCanView: boolean | null;
  explicitCanEdit: boolean | null;
  explicitCanShare: boolean | null;
  explicitCanDelete: boolean | null;
}

const FULL = { canView: true, canEdit: true, canShare: true, canDelete: true };
const NONE = { canView: false, canEdit: false, canShare: false, canDelete: false };

function makeRow(overrides: Partial<Row> & { pageId: string }): Row {
  return {
    isTrashed: false,
    driveOwnerId: null,
    adminMemberId: null,
    explicitCanView: null,
    explicitCanEdit: null,
    explicitCanShare: null,
    explicitCanDelete: null,
    ...overrides,
  };
}

/**
 * Stubs the Drizzle chain:
 *   db.select({...})
 *     .from(pages)
 *     .leftJoin(drives, ...)
 *     .leftJoin(driveMembers, ...)
 *     .leftJoin(pagePermissions, ...)
 *     .where(...)
 *
 * The terminal `.where(...)` resolves to the provided rows.
 */
function stubQueryRows(rows: Row[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const leftJoin3 = vi.fn().mockReturnValue({ where });
  const leftJoin2 = vi.fn().mockReturnValue({ leftJoin: leftJoin3, where });
  const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2, where });
  const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1, where });
  vi.mocked(db.select).mockReturnValueOnce(
    { from } as unknown as ReturnType<typeof db.select>
  );
}

// ---------------------------------------------------------------------------
// Tests — acceptance criteria for the collapsed CTE
// ---------------------------------------------------------------------------

describe('getBatchPagePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Guard rail: one DB round-trip per batch — not a loop over canUserViewPage.
  it('given a batch of pageIds, should issue exactly one db.select call', async () => {
    stubQueryRows([]);

    await getBatchPagePermissions(USER, ['p1', 'p2', 'p3', 'p4']);

    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('given an empty pageIds array, should return an empty map without querying the DB', async () => {
    const result = await getBatchPagePermissions(USER, []);

    expect(result.size).toBe(0);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('given owner access, should grant all four permissions', async () => {
    stubQueryRows([makeRow({ pageId: 'p1', driveOwnerId: USER })]);

    const result = await getBatchPagePermissions(USER, ['p1']);

    expect(result.get('p1')).toEqual(FULL);
  });

  it('given an accepted ADMIN member, should grant all four permissions', async () => {
    // Invariant from the CTE: the drive_members LEFT JOIN already filters on
    // role = 'ADMIN' AND acceptedAt IS NOT NULL, so a non-null adminMemberId
    // here encodes an accepted admin.
    stubQueryRows([makeRow({ pageId: 'p1', adminMemberId: 'member_x' })]);

    const result = await getBatchPagePermissions(USER, ['p1']);

    expect(result.get('p1')).toEqual(FULL);
  });

  it('given an unaccepted ADMIN invite (adminMemberId null), should fall through to explicit-grant check', async () => {
    // The CTE's acceptedAt IS NOT NULL predicate causes an unaccepted admin
    // invite to yield adminMemberId = null. With no explicit grant, this
    // degrades to all-false.
    stubQueryRows([makeRow({ pageId: 'p1', adminMemberId: null })]);

    const result = await getBatchPagePermissions(USER, ['p1']);

    expect(result.get('p1')).toEqual(NONE);
  });

  it('given an explicit grant with unexpired expires_at, should return the grant verbatim', async () => {
    // The pagePermissions LEFT JOIN filters expired rows out at the SQL
    // level, so an unexpired row shows up with its explicit* fields
    // populated.
    stubQueryRows([
      makeRow({
        pageId: 'p1',
        explicitCanView: true,
        explicitCanEdit: true,
        explicitCanShare: false,
        explicitCanDelete: false,
      }),
    ]);

    const result = await getBatchPagePermissions(USER, ['p1']);

    expect(result.get('p1')).toEqual({
      canView: true,
      canEdit: true,
      canShare: false,
      canDelete: false,
    });
  });

  it('given an explicit grant with expired expires_at, should return all four false', async () => {
    // Expired grants are filtered out by the CTE's WHERE clause on the
    // pagePermissions join, so they surface as all-null explicit* fields.
    stubQueryRows([makeRow({ pageId: 'p1' })]);

    const result = await getBatchPagePermissions(USER, ['p1']);

    expect(result.get('p1')).toEqual(NONE);
  });

  it('given a trashed page, should return all four false even when the user is drive owner', async () => {
    stubQueryRows([
      makeRow({ pageId: 'p1', isTrashed: true, driveOwnerId: USER }),
    ]);

    const result = await getBatchPagePermissions(USER, ['p1']);

    expect(result.get('p1')).toEqual(NONE);
  });

  it('given an inaccessible pageId (row exists, no grants), should return all four false', async () => {
    stubQueryRows([makeRow({ pageId: 'p1' })]);

    const result = await getBatchPagePermissions(USER, ['p1']);

    expect(result.get('p1')).toEqual(NONE);
  });

  it('given a non-existent pageId, should return all four false by seeded default', async () => {
    // The CTE WHERE pages.id = ANY($pageIds) filters out non-existent pages,
    // so they never appear in rows. The implementation seeds every input
    // pageId with NONE before iterating rows so callers still get an entry.
    stubQueryRows([]);

    const result = await getBatchPagePermissions(USER, ['missing']);

    expect(result.get('missing')).toEqual(NONE);
  });

  it('given a mixed batch, should classify each pageId independently', async () => {
    stubQueryRows([
      makeRow({ pageId: 'owned', driveOwnerId: USER }),
      makeRow({ pageId: 'admin', adminMemberId: 'member_1' }),
      makeRow({
        pageId: 'granted',
        explicitCanView: true,
        explicitCanEdit: false,
        explicitCanShare: false,
        explicitCanDelete: false,
      }),
      makeRow({ pageId: 'trashed', isTrashed: true, driveOwnerId: USER }),
      makeRow({ pageId: 'denied' }),
    ]);

    const result = await getBatchPagePermissions(USER, [
      'owned',
      'admin',
      'granted',
      'trashed',
      'denied',
      'missing',
    ]);

    expect(result.get('owned')).toEqual(FULL);
    expect(result.get('admin')).toEqual(FULL);
    expect(result.get('granted')).toEqual({
      canView: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
    });
    expect(result.get('trashed')).toEqual(NONE);
    expect(result.get('denied')).toEqual(NONE);
    expect(result.get('missing')).toEqual(NONE);
    expect(result.size).toBe(6);
  });

  it('should filter drive_members join on acceptedAt IS NOT NULL (matches single-page path)', async () => {
    stubQueryRows([]);

    await getBatchPagePermissions(USER, ['p1']);

    expect(vi.mocked(isNotNull)).toHaveBeenCalledWith('acceptedAt');
  });

  it('given a DB failure, should return the pre-seeded deny map (fail-closed)', async () => {
    const where = vi.fn().mockRejectedValue(new Error('DB down'));
    const leftJoin3 = vi.fn().mockReturnValue({ where });
    const leftJoin2 = vi.fn().mockReturnValue({ leftJoin: leftJoin3, where });
    const leftJoin1 = vi.fn().mockReturnValue({ leftJoin: leftJoin2, where });
    const from = vi.fn().mockReturnValue({ leftJoin: leftJoin1, where });
    vi.mocked(db.select).mockReturnValueOnce(
      { from } as unknown as ReturnType<typeof db.select>
    );

    const result = await getBatchPagePermissions(USER, ['p1', 'p2']);

    expect(result.get('p1')).toEqual(NONE);
    expect(result.get('p2')).toEqual(NONE);
  });
});

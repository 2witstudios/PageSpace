import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db', () => ({
  db: {
    select: vi.fn(),
    query: {
      drives: { findFirst: vi.fn() },
    },
  },
  pages: { id: 'id', driveId: 'driveId' },
  drives: { id: 'id', ownerId: 'ownerId' },
  driveMembers: { driveId: 'driveId', userId: 'userId', role: 'role', id: 'id' },
  pagePermissions: {
    pageId: 'pageId', userId: 'userId', canView: 'canView', canEdit: 'canEdit',
    canShare: 'canShare', canDelete: 'canDelete', expiresAt: 'expiresAt', id: 'id',
  },
  eq: vi.fn((_a, _b) => 'eq'),
  and: vi.fn((...args) => ({ and: args })),
  or: vi.fn((...args) => ({ or: args })),
  isNull: vi.fn((a) => ({ isNull: a })),
  gt: vi.fn((a, b) => ({ gt: { a, b } })),
}));

vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: {
      debug: vi.fn(),
      error: vi.fn(),
    },
  },
}));

vi.mock('../../validators', () => ({
  parseUserId: vi.fn(),
  parsePageId: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import {
  getDriveIdsForUser,
  getUserAccessLevel,
  canUserViewPage,
  canUserEditPage,
  canUserSharePage,
  canUserDeletePage,
  isDriveOwnerOrAdmin,
  isUserDriveMember,
  getUserAccessiblePagesInDrive,
  getUserAccessiblePagesInDriveWithDetails,
  getUserDriveAccess,
} from '../permissions';
import { db } from '@pagespace/db';
import { parseUserId, parsePageId } from '../../validators';
import { loggers } from '../../logging/logger-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_USER = 'clxxxxxxxxxxxxxxxxxxxxxxx';
const VALID_PAGE = 'clyyyyyyyyyyyyyyyyyyyyyyy';
const VALID_DRIVE = 'clzzzzzzzzzzzzzzzzzzzzzzz';

function mockValidators(userOk = true, pageOk = true) {
  if (userOk) {
    vi.mocked(parseUserId).mockReturnValue({ success: true, data: VALID_USER });
  } else {
    vi.mocked(parseUserId).mockReturnValue({
      success: false,
      error: Object.assign(new Error('invalid userId'), { code: 'INVALID_ID_FORMAT' as const, field: 'userId', name: 'IdValidationError' as const }),
    });
  }

  if (pageOk) {
    vi.mocked(parsePageId).mockReturnValue({ success: true, data: VALID_PAGE });
  } else {
    vi.mocked(parsePageId).mockReturnValue({
      success: false,
      error: Object.assign(new Error('invalid pageId'), { code: 'INVALID_ID_FORMAT' as const, field: 'pageId', name: 'IdValidationError' as const }),
    });
  }
}

/** @scaffold — ORM chain mock: db.select().from().leftJoin/innerJoin().where().limit() */
function makeSelectChain(rows: unknown[]) {
  const limitFn = vi.fn().mockResolvedValue(rows);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const leftJoinFn = vi.fn().mockReturnValue({ where: whereFn });
  const innerJoinFn = vi.fn().mockReturnValue({ where: whereFn });
  const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn, innerJoin: innerJoinFn, where: whereFn });
  vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);
  return { limitFn, whereFn, fromFn };
}

// ---------------------------------------------------------------------------
// getDriveIdsForUser
// ---------------------------------------------------------------------------
describe('getDriveIdsForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns union of owned drives, member drives, and page permission drives', async () => {
    const ownedDrive = [{ id: 'drive-owned' }];
    const memberDrive = [{ driveId: 'drive-member' }];
    const pageDrive = [{ driveId: 'drive-page-perm' }];

    vi.mocked(db.select)
      .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(ownedDrive) }) } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(memberDrive) }) } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(pageDrive),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getDriveIdsForUser('user-1');

    expect(result).toContain('drive-owned');
    expect(result).toContain('drive-member');
    expect(result).toContain('drive-page-perm');
    expect(result).toHaveLength(3);
  });

  it('deduplicates when same drive appears in multiple sources', async () => {
    const sameId = 'drive-same';

    vi.mocked(db.select)
      .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ id: sameId }]) }) } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ driveId: sameId }]) }) } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ driveId: sameId }]),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getDriveIdsForUser('user-1');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(sameId);
  });

  it('skips null driveId from page permissions', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ driveId: null }]),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getDriveIdsForUser('user-1');
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getUserAccessLevel
// ---------------------------------------------------------------------------
describe('getUserAccessLevel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for invalid userId', async () => {
    mockValidators(false, true);
    const result = await getUserAccessLevel('bad-id', VALID_PAGE);
    expect(result).toBeNull();
  });

  it('returns null for invalid pageId', async () => {
    mockValidators(true, false);
    const result = await getUserAccessLevel(VALID_USER, 'bad-id');
    expect(result).toBeNull();
  });

  it('logs debug message for invalid userId when silent=false', async () => {
    mockValidators(false, true);
    await getUserAccessLevel('bad-id', VALID_PAGE, { silent: false });
    expect(loggers.api.debug).toHaveBeenCalledWith(expect.stringContaining('userId'));
  });

  it('logs debug message for invalid pageId when silent=false', async () => {
    mockValidators(true, false);
    await getUserAccessLevel(VALID_USER, 'bad-id', { silent: false });
    expect(loggers.api.debug).toHaveBeenCalledWith(expect.stringContaining('pageId'));
  });

  it('returns null when page not found', async () => {
    mockValidators(true, true);
    const limitFn = vi.fn().mockResolvedValue([]);
    const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
    const leftJoinFn = vi.fn().mockReturnValue({ where: whereFn });
    const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toBeNull();
  });

  it('logs page not found debug when silent=false', async () => {
    mockValidators(true, true);
    const limitFn = vi.fn().mockResolvedValue([]);
    const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
    const leftJoinFn = vi.fn().mockReturnValue({ where: whereFn });
    const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);

    await getUserAccessLevel(VALID_USER, VALID_PAGE, { silent: false });
    expect(loggers.api.debug).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('returns full access when user is drive owner', async () => {
    mockValidators(true, true);
    const page = [{ id: VALID_PAGE, driveId: VALID_DRIVE, driveOwnerId: VALID_USER }];
    const limitFn = vi.fn().mockResolvedValue(page);
    const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
    const leftJoinFn = vi.fn().mockReturnValue({ where: whereFn });
    const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
  });

  it('returns full access when user is drive admin', async () => {
    mockValidators(true, true);
    const page = [{ id: VALID_PAGE, driveId: VALID_DRIVE, driveOwnerId: 'other-owner' }];
    const adminMembership = [{ id: 'member-id' }];

    vi.mocked(db.select)
      // First call: page lookup
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(page) }),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // Second call: admin check
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(adminMembership) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
  });

  it('returns explicit permissions when user has them', async () => {
    mockValidators(true, true);
    const page = [{ id: VALID_PAGE, driveId: VALID_DRIVE, driveOwnerId: 'other-owner' }];
    const explicitPerm = [{ canView: true, canEdit: false, canShare: false, canDelete: false }];

    vi.mocked(db.select)
      // page lookup
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(page) }),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // admin check (no admin)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // explicit permissions
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(explicitPerm) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  });

  it('returns null when no explicit permissions found (expired or missing)', async () => {
    mockValidators(true, true);
    const page = [{ id: VALID_PAGE, driveId: VALID_DRIVE, driveOwnerId: 'other-owner' }];

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(page) }),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toBeNull();
  });

  it('logs no-permissions message when silent=false and no explicit permissions', async () => {
    mockValidators(true, true);
    const page = [{ id: VALID_PAGE, driveId: VALID_DRIVE, driveOwnerId: 'other-owner' }];

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(page) }),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE, { silent: false });
    expect(result).toBeNull();
    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('No explicit permissions found')
    );
  });

  it('logs found-permissions message when silent=false and has explicit permissions', async () => {
    mockValidators(true, true);
    const page = [{ id: VALID_PAGE, driveId: VALID_DRIVE, driveOwnerId: 'other-owner' }];
    const explicitPerm = [{ canView: true, canEdit: false, canShare: false, canDelete: false }];

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(page) }),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(explicitPerm) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE, { silent: false });
    expect(result).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('Found explicit permissions')
    );
  });

  it('returns null and logs error when DB throws', async () => {
    mockValidators(true, true);

    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockRejectedValue(new Error('DB error')) }),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toBeNull();
    expect(loggers.api.error).toHaveBeenCalledWith(
      '[PERMISSIONS] Error checking user access level',
      { userId: VALID_USER, pageId: VALID_PAGE, error: 'DB error' },
    );
  });

  it('returns null when page has no driveId (admin check skipped)', async () => {
    mockValidators(true, true);
    const page = [{ id: VALID_PAGE, driveId: null, driveOwnerId: 'other-owner' }];

    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(page) }),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // explicit permissions - empty
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessLevel(VALID_USER, VALID_PAGE);
    expect(result).toBeNull();
  });

  it('logs verbose debug when silent=false and user is drive owner', async () => {
    mockValidators(true, true);
    const page = [{ id: VALID_PAGE, driveId: VALID_DRIVE, driveOwnerId: VALID_USER }];
    const limitFn = vi.fn().mockResolvedValue(page);
    const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
    const leftJoinFn = vi.fn().mockReturnValue({ where: whereFn });
    const fromFn = vi.fn().mockReturnValue({ leftJoin: leftJoinFn });
    vi.mocked(db.select).mockReturnValue({ from: fromFn } as unknown as ReturnType<typeof db.select>);

    await getUserAccessLevel(VALID_USER, VALID_PAGE, { silent: false });
    expect(loggers.api.debug).toHaveBeenCalledWith(expect.stringContaining('owner'));
  });
});

// ---------------------------------------------------------------------------
// canUserViewPage / canUserEditPage / canUserSharePage / canUserDeletePage
// ---------------------------------------------------------------------------

/** @scaffold — ORM chain mock: sets up getUserAccessLevel return via inline chain mocks */
function setupAccessLevel(perms: { canView: boolean; canEdit: boolean; canShare: boolean; canDelete: boolean } | null) {
  mockValidators(true, true);
  if (perms === null) {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);
  } else {
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: VALID_PAGE, driveId: VALID_DRIVE, driveOwnerId: VALID_USER }]),
          }),
        }),
      }),
    } as unknown as ReturnType<typeof db.select>);
  }
}

describe('canUserViewPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns true when user has view access', async () => {
    setupAccessLevel({ canView: true, canEdit: false, canShare: false, canDelete: false });
    const result = await canUserViewPage(VALID_USER, VALID_PAGE);
    expect(result).toBe(true);
  });

  it('returns false when user has no access', async () => {
    setupAccessLevel(null);
    const result = await canUserViewPage(VALID_USER, VALID_PAGE);
    expect(result).toBe(false);
  });
});

describe('canUserEditPage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns true when user is owner (edit=true)', async () => {
    setupAccessLevel({ canView: true, canEdit: true, canShare: true, canDelete: true });
    const result = await canUserEditPage(VALID_USER, VALID_PAGE);
    expect(result).toBe(true);
  });

  it('returns false when user has no access', async () => {
    setupAccessLevel(null);
    const result = await canUserEditPage(VALID_USER, VALID_PAGE);
    expect(result).toBe(false);
  });
});

describe('canUserSharePage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns true when user is owner (share=true)', async () => {
    setupAccessLevel({ canView: true, canEdit: true, canShare: true, canDelete: true });
    const result = await canUserSharePage(VALID_USER, VALID_PAGE);
    expect(result).toBe(true);
  });

  it('returns false when no access', async () => {
    setupAccessLevel(null);
    const result = await canUserSharePage(VALID_USER, VALID_PAGE);
    expect(result).toBe(false);
  });
});

describe('canUserDeletePage', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns true when user is owner (delete=true)', async () => {
    setupAccessLevel({ canView: true, canEdit: true, canShare: true, canDelete: true });
    const result = await canUserDeletePage(VALID_USER, VALID_PAGE);
    expect(result).toBe(true);
  });

  it('returns false when no access', async () => {
    setupAccessLevel(null);
    const result = await canUserDeletePage(VALID_USER, VALID_PAGE);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDriveOwnerOrAdmin
// ---------------------------------------------------------------------------
describe('isDriveOwnerOrAdmin', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns true when user is drive owner', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: VALID_DRIVE, ownerId: VALID_USER }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await isDriveOwnerOrAdmin(VALID_USER, VALID_DRIVE);
    expect(result).toBe(true);
  });

  it('returns true when user is admin member', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: VALID_DRIVE, ownerId: 'other-user' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: 'member-id' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await isDriveOwnerOrAdmin(VALID_USER, VALID_DRIVE);
    expect(result).toBe(true);
  });

  it('returns false when user is neither owner nor admin', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: VALID_DRIVE, ownerId: 'other-user' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await isDriveOwnerOrAdmin(VALID_USER, VALID_DRIVE);
    expect(result).toBe(false);
  });

  it('returns false when drive not found', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await isDriveOwnerOrAdmin(VALID_USER, VALID_DRIVE);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isUserDriveMember
// ---------------------------------------------------------------------------
describe('isUserDriveMember', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns true when user is drive owner', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ ownerId: VALID_USER }]) }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await isUserDriveMember(VALID_USER, VALID_DRIVE);
    expect(result).toBe(true);
  });

  it('returns true when user is a drive member', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ ownerId: 'other-user' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: 'member-row' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await isUserDriveMember(VALID_USER, VALID_DRIVE);
    expect(result).toBe(true);
  });

  it('returns false when user is neither owner nor member', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ ownerId: 'other-user' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await isUserDriveMember(VALID_USER, VALID_DRIVE);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getUserAccessiblePagesInDrive
// ---------------------------------------------------------------------------
describe('getUserAccessiblePagesInDrive', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns all page IDs when user is drive owner', async () => {
    const allPageIds = [{ id: 'page-1' }, { id: 'page-2' }];
    vi.mocked(db.select)
      // drive lookup
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ ownerId: VALID_USER }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // all pages
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(allPageIds) }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessiblePagesInDrive(VALID_USER, VALID_DRIVE);
    expect(result).toEqual(['page-1', 'page-2']);
  });

  it('returns all page IDs when user is admin', async () => {
    const allPageIds = [{ id: 'page-1' }];
    vi.mocked(db.select)
      // drive lookup (not owner)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ ownerId: 'other-user' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // admin check
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: 'admin-member' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // all pages
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(allPageIds) }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessiblePagesInDrive(VALID_USER, VALID_DRIVE);
    expect(result).toEqual(['page-1']);
  });

  it('returns only explicitly permissioned pages for regular member', async () => {
    const permPages = [{ pageId: 'page-with-perm' }];
    vi.mocked(db.select)
      // drive lookup (not owner)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ ownerId: 'other-user' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // admin check (not admin)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // explicit permissions
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(permPages) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessiblePagesInDrive(VALID_USER, VALID_DRIVE);
    expect(result).toEqual(['page-with-perm']);
  });
});

// ---------------------------------------------------------------------------
// getUserAccessiblePagesInDriveWithDetails
// ---------------------------------------------------------------------------
describe('getUserAccessiblePagesInDriveWithDetails', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns empty array when drive not found', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessiblePagesInDriveWithDetails(VALID_USER, VALID_DRIVE);
    expect(result).toEqual([]);
  });

  it('returns all pages with full permissions for drive owner', async () => {
    const allPages = [
      { id: 'page-1', title: 'Page 1', type: 'DOCUMENT', parentId: null, position: 1, isTrashed: false },
    ];
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ ownerId: VALID_USER }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(allPages),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessiblePagesInDriveWithDetails(VALID_USER, VALID_DRIVE);
    expect(result).toHaveLength(1);
    expect(result[0].permissions).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
  });

  it('returns pages with explicit permissions for non-owner', async () => {
    const permPages = [
      { id: 'page-1', title: 'Page 1', type: 'DOCUMENT', parentId: null, position: 1, isTrashed: false,
        canView: true, canEdit: false, canShare: false, canDelete: false },
    ];
    vi.mocked(db.select)
      // drive lookup
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ ownerId: 'other-user' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // admin check
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // pages with permissions join
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(permPages) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserAccessiblePagesInDriveWithDetails(VALID_USER, VALID_DRIVE);
    expect(result).toHaveLength(1);
    expect(result[0].permissions).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
  });
});

// ---------------------------------------------------------------------------
// getUserDriveAccess
// ---------------------------------------------------------------------------
describe('getUserDriveAccess', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns false when drive not found', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await getUserDriveAccess(VALID_USER, VALID_DRIVE);
    expect(result).toBe(false);
  });

  it('returns true when user is drive owner', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: VALID_DRIVE, ownerId: VALID_USER }]) }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await getUserDriveAccess(VALID_USER, VALID_DRIVE);
    expect(result).toBe(true);
  });

  it('returns true when user is a drive member', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: VALID_DRIVE, ownerId: 'other-user' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: 'member-row' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserDriveAccess(VALID_USER, VALID_DRIVE);
    expect(result).toBe(true);
  });

  it('returns true when user has page permissions in the drive', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: VALID_DRIVE, ownerId: 'other-user' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // membership check: not member
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // page access check
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: 'perm-row' }]) }),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserDriveAccess(VALID_USER, VALID_DRIVE);
    expect(result).toBe(true);
  });

  it('returns false when user has no access', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: VALID_DRIVE, ownerId: 'other-user' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserDriveAccess(VALID_USER, VALID_DRIVE);
    expect(result).toBe(false);
  });

  it('returns false and logs error on exception', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockRejectedValue(new Error('DB failure')) }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await getUserDriveAccess(VALID_USER, VALID_DRIVE);
    expect(result).toBe(false);
    expect(loggers.api.error).toHaveBeenCalledWith(
      '[DRIVE_ACCESS] Error checking user drive access',
      { userId: VALID_USER, driveId: VALID_DRIVE, error: 'DB failure' },
    );
  });

  it('logs owner grant message when silent=false and user is owner', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: VALID_DRIVE, ownerId: VALID_USER }]) }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    const result = await getUserDriveAccess(VALID_USER, VALID_DRIVE, { silent: false });
    expect(result).toBe(true);
    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('User is drive owner')
    );
  });

  it('logs membership message when silent=false and user is a drive member', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: VALID_DRIVE, ownerId: 'other-user' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: 'member-row' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserDriveAccess(VALID_USER, VALID_DRIVE, { silent: false });
    expect(result).toBe(true);
    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('User is a drive member')
    );
  });

  it('logs debug messages when silent=false', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
      }),
    } as unknown as ReturnType<typeof db.select>);

    await getUserDriveAccess(VALID_USER, VALID_DRIVE, { silent: false });
    expect(loggers.api.debug).toHaveBeenCalledWith(expect.stringContaining('not found'));
  });

  it('logs page access check messages when silent=false and user is not a member', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: VALID_DRIVE, ownerId: 'other-user' }]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // membership check: not member
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      } as unknown as ReturnType<typeof db.select>)
      // page access check: has access
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([{ id: 'perm-row' }]) }),
          }),
        }),
      } as unknown as ReturnType<typeof db.select>);

    const result = await getUserDriveAccess(VALID_USER, VALID_DRIVE, { silent: false });
    expect(result).toBe(true);
    // Should have logged "not a drive member - checking page permissions" and "Page access check result"
    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('not a drive member')
    );
    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('Page access check result')
    );
  });
});

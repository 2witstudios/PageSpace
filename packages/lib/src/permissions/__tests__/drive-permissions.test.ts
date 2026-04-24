import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@pagespace/db', () => ({
  db: { select: vi.fn() },
  pages: { id: 'id', driveId: 'driveId' },
  drives: { id: 'id', ownerId: 'ownerId' },
  driveMembers: {
    id: 'id',
    driveId: 'driveId',
    userId: 'userId',
    role: 'role',
    acceptedAt: 'acceptedAt',
  },
  pagePermissions: {
    id: 'id',
    pageId: 'pageId',
    userId: 'userId',
    canView: 'canView',
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

import { getUserDrivePermissions, getUserDriveAccess } from '../permissions';
import { db } from '@pagespace/db/db';
import { isNotNull } from '@pagespace/db/operators';
import { loggers } from '../../logging/logger-config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER = 'user_abc';
const DRIVE = 'drive_xyz';

function stubDriveLookup(rows: Array<{ id: string; ownerId: string }>) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

function stubMembershipLookup(rows: Array<{ role?: string; id?: string }>) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

function stubLeftJoinLookup(rows: Array<{ id?: string }>) {
  return {
    from: vi.fn().mockReturnValue({
      leftJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(rows),
        }),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

// ---------------------------------------------------------------------------
// getUserDrivePermissions — unit tests against the collapsed permissions.ts
// ---------------------------------------------------------------------------

describe('getUserDrivePermissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given an owner, returns { hasAccess: true, isOwner: true, canEdit: true }', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      stubDriveLookup([{ id: DRIVE, ownerId: USER }])
    );

    const result = await getUserDrivePermissions(USER, DRIVE);

    expect(result).toEqual({
      hasAccess: true,
      isOwner: true,
      isAdmin: false,
      isMember: false,
      canEdit: true,
    });
  });

  it('given an accepted ADMIN member, returns { isAdmin: true, isMember: true, canEdit: true }', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubDriveLookup([{ id: DRIVE, ownerId: 'other-user' }]))
      .mockReturnValueOnce(stubMembershipLookup([{ role: 'ADMIN' }]));

    const result = await getUserDrivePermissions(USER, DRIVE);

    expect(result).toEqual({
      hasAccess: true,
      isOwner: false,
      isAdmin: true,
      isMember: true,
      canEdit: true,
    });
  });

  it('given an accepted MEMBER, returns { isMember: true, canEdit: true }', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubDriveLookup([{ id: DRIVE, ownerId: 'other-user' }]))
      .mockReturnValueOnce(stubMembershipLookup([{ role: 'MEMBER' }]));

    const result = await getUserDrivePermissions(USER, DRIVE);

    expect(result).toEqual({
      hasAccess: true,
      isOwner: false,
      isAdmin: false,
      isMember: true,
      canEdit: true,
    });
  });

  it('given a VIEWER role, returns { isMember: true, canEdit: false }', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubDriveLookup([{ id: DRIVE, ownerId: 'other-user' }]))
      .mockReturnValueOnce(stubMembershipLookup([{ role: 'VIEWER' }]));

    const result = await getUserDrivePermissions(USER, DRIVE);

    expect(result).toEqual({
      hasAccess: true,
      isOwner: false,
      isAdmin: false,
      isMember: true,
      canEdit: false,
    });
  });

  it('given no drive, returns null', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubDriveLookup([]));

    const result = await getUserDrivePermissions(USER, DRIVE);

    expect(result).toBeNull();
  });

  it('given no drive membership (page collaborator), returns null', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubDriveLookup([{ id: DRIVE, ownerId: 'other-user' }]))
      .mockReturnValueOnce(stubMembershipLookup([]));

    const result = await getUserDrivePermissions(USER, DRIVE);

    expect(result).toBeNull();
  });

  it('given silent: false, emits a debug log on drive lookup', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubDriveLookup([]));

    await getUserDrivePermissions(USER, DRIVE, { silent: false });

    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('[DRIVE_PERMISSIONS] Drive not found')
    );
  });

  it('given silent: false on owner path, emits a debug log', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      stubDriveLookup([{ id: DRIVE, ownerId: USER }])
    );

    await getUserDrivePermissions(USER, DRIVE, { silent: false });

    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('[DRIVE_PERMISSIONS] User is drive owner')
    );
  });

  it('given silent: false on member path, emits a debug log', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubDriveLookup([{ id: DRIVE, ownerId: 'other-user' }]))
      .mockReturnValueOnce(stubMembershipLookup([{ role: 'ADMIN' }]));

    await getUserDrivePermissions(USER, DRIVE, { silent: false });

    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('[DRIVE_PERMISSIONS] User is drive member with role: ADMIN')
    );
  });

  it('given silent: false on no-membership path, emits a debug log', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubDriveLookup([{ id: DRIVE, ownerId: 'other-user' }]))
      .mockReturnValueOnce(stubMembershipLookup([]));

    await getUserDrivePermissions(USER, DRIVE, { silent: false });

    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('[DRIVE_PERMISSIONS] User has no drive-level membership')
    );
  });

  it('given a DB error, returns null and logs (fail-closed)', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('DB down');
    });

    const result = await getUserDrivePermissions(USER, DRIVE);

    expect(result).toBeNull();
    expect(loggers.api.error).toHaveBeenCalledWith(
      '[DRIVE_PERMISSIONS] Error checking drive permissions',
      expect.objectContaining({ userId: USER, driveId: DRIVE })
    );
  });

  it('invokes the accepted-only membership filter (isNotNull(acceptedAt))', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubDriveLookup([{ id: DRIVE, ownerId: 'other-user' }]))
      .mockReturnValueOnce(stubMembershipLookup([{ role: 'MEMBER' }]));

    await getUserDrivePermissions(USER, DRIVE);

    expect(vi.mocked(isNotNull)).toHaveBeenCalledWith('acceptedAt');
  });
});

// ---------------------------------------------------------------------------
// getUserDriveAccess — coverage for the silent-mode debug branches
// ---------------------------------------------------------------------------

describe('getUserDriveAccess (silent: false branches)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('given drive not found, logs and returns false', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubDriveLookup([]));

    const result = await getUserDriveAccess(USER, DRIVE, { silent: false });

    expect(result).toBe(false);
    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('[DRIVE_ACCESS] Drive not found')
    );
  });

  it('given drive owner, logs and returns true', async () => {
    vi.mocked(db.select).mockReturnValueOnce(
      stubDriveLookup([{ id: DRIVE, ownerId: USER }])
    );

    const result = await getUserDriveAccess(USER, DRIVE, { silent: false });

    expect(result).toBe(true);
    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('[DRIVE_ACCESS] User is drive owner')
    );
  });

  it('given accepted drive member, logs and returns true', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubDriveLookup([{ id: DRIVE, ownerId: 'other-user' }]))
      .mockReturnValueOnce(stubMembershipLookup([{ id: 'member-row' }]));

    const result = await getUserDriveAccess(USER, DRIVE, { silent: false });

    expect(result).toBe(true);
    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('[DRIVE_ACCESS] User is a drive member - granting access')
    );
  });

  it('given no membership but has page permission, logs and returns true', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubDriveLookup([{ id: DRIVE, ownerId: 'other-user' }]))
      .mockReturnValueOnce(stubMembershipLookup([]))
      .mockReturnValueOnce(stubLeftJoinLookup([{ id: 'page-perm-row' }]));

    const result = await getUserDriveAccess(USER, DRIVE, { silent: false });

    expect(result).toBe(true);
    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('[DRIVE_ACCESS] Page access check result: true')
    );
  });

  it('given no access at all, logs and returns false', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubDriveLookup([{ id: DRIVE, ownerId: 'other-user' }]))
      .mockReturnValueOnce(stubMembershipLookup([]))
      .mockReturnValueOnce(stubLeftJoinLookup([]));

    const result = await getUserDriveAccess(USER, DRIVE, { silent: false });

    expect(result).toBe(false);
    expect(loggers.api.debug).toHaveBeenCalledWith(
      expect.stringContaining('[DRIVE_ACCESS] Page access check result: false')
    );
  });

  it('given a DB error, returns false (fail-closed) and logs', async () => {
    vi.mocked(db.select).mockImplementationOnce(() => {
      throw new Error('DB down');
    });

    const result = await getUserDriveAccess(USER, DRIVE);

    expect(result).toBe(false);
    expect(loggers.api.error).toHaveBeenCalledWith(
      '[DRIVE_ACCESS] Error checking user drive access',
      expect.objectContaining({ userId: USER, driveId: DRIVE })
    );
  });
});

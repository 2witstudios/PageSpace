import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn() },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', isPrivate: 'isPrivate', isTrashed: 'isTrashed' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  mcpTokenDrives: {
    id: 'id',
    tokenId: 'tokenId',
    driveId: 'driveId',
    role: 'role',
    customRoleId: 'customRoleId',
  },
  driveRoles: {
    id: 'id',
    driveId: 'driveId',
    permissions: 'permissions',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn((_a: unknown, _b: unknown) => 'eq'),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  inArray: vi.fn((_a: unknown, _b: unknown) => 'inArray'),
}));

import {
  getAppAccessLevel,
  hasAppDriveMembership,
  getAppDriveMembership,
  getAppDriveAccessLevel,
  getAppAccessiblePagesInDrive,
} from '../app-permissions';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';

const TOKEN_ID = 'mcp_aaaaaaaaaaaaaaaaaaaaaa';
const PAGE_ID = 'page_bbbbbbbbbbbbbbbbbbbbbbb';
const DRIVE_ID = 'drive_cccccccccccccccccccccc';
const CUSTOM_ROLE_ID = 'role_dddddddddddddddddddddd';

function stubSelect(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

describe('getAppAccessLevel — page targets', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when token has no membership in the drive', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID }]))
      .mockReturnValueOnce(stubSelect([]));

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toBeNull();
  });

  it('returns full access for ADMIN role', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID }]))
      .mockReturnValueOnce(stubSelect([{ role: 'ADMIN', customRoleId: null }]));

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toEqual({
      canView: true, canEdit: true, canShare: true, canDelete: true,
    });
  });

  it('returns read-only for MEMBER with no custom role', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID }]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }]));

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toEqual({
      canView: true, canEdit: false, canShare: false, canDelete: false,
    });
  });

  it('returns custom role permissions for MEMBER with custom role', async () => {
    const perms = { [PAGE_ID]: { canView: true, canEdit: true, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID }]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(stubSelect([{ permissions: perms, driveWidePermissions: null }]));

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toEqual({
      canView: true, canEdit: true, canShare: false, canDelete: false,
    });
  });

  it('denies MCP token with driveWidePermissions:{canView:true} and no per-page entry access to a PRIVATE page', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID, isPrivate: true }]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(stubSelect([{ permissions: {}, driveWidePermissions: { canView: true, canEdit: false, canShare: false } }]));

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toBeNull();
  });

  it('grants MCP token with driveWidePermissions AND explicit per-page entry access to a PRIVATE page', async () => {
    const perms = { [PAGE_ID]: { canView: true, canEdit: false, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID, isPrivate: true }]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(stubSelect([{ permissions: perms, driveWidePermissions: { canView: true, canEdit: false, canShare: false } }]));

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toEqual({
      canView: true, canEdit: false, canShare: false, canDelete: false,
    });
  });
});

describe('getAppAccessLevel — drive-as-root-node', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when token has no membership (drive target)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([]))
      .mockReturnValueOnce(stubSelect([]));

    expect(await getAppAccessLevel(TOKEN_ID, DRIVE_ID)).toBeNull();
  });

  it('returns full access for ADMIN role on drive target', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([]))
      .mockReturnValueOnce(stubSelect([{ role: 'ADMIN', customRoleId: null }]));

    expect(await getAppAccessLevel(TOKEN_ID, DRIVE_ID)).toEqual({
      canView: true, canEdit: true, canShare: true, canDelete: true,
    });
  });

  it('returns all-false when custom role has no entry for the drive', async () => {
    const perms = { 'page_other': { canView: true, canEdit: true, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(stubSelect([{ permissions: perms, driveWidePermissions: null }]));

    expect(await getAppAccessLevel(TOKEN_ID, DRIVE_ID)).toEqual({
      canView: false, canEdit: false, canShare: false, canDelete: false,
    });
  });
});

// Stub for queries that resolve directly from .where() (no .limit()), e.g. the
// page-enumeration queries in getAppAccessiblePagesInDrive.
function stubSelectList(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  } as unknown as ReturnType<typeof db.select>;
}

describe('getAppAccessLevel — private pages', () => {
  beforeEach(() => vi.clearAllMocks());

  it('denies a plain MEMBER token access to a private page (mirrors plain-member user/agent)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID, isPrivate: true }]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }]));

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toBeNull();
  });

  it('still grants an ADMIN token access to a private page', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID, isPrivate: true }]))
      .mockReturnValueOnce(stubSelect([{ role: 'ADMIN', customRoleId: null }]));

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toEqual({
      canView: true, canEdit: true, canShare: true, canDelete: true,
    });
  });

  it('honours an explicit custom-role grant on a private page', async () => {
    const perms = { [PAGE_ID]: { canView: true, canEdit: false, canShare: false } };
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ driveId: DRIVE_ID, isPrivate: true }]))
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(stubSelect([{ permissions: perms, driveWidePermissions: null }]));

    expect(await getAppAccessLevel(TOKEN_ID, PAGE_ID)).toEqual({
      canView: true, canEdit: false, canShare: false, canDelete: false,
    });
  });
});

describe('getAppDriveMembership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns role and customRoleId when membership exists', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([{ role: 'ADMIN', customRoleId: null }]));
    expect(await getAppDriveMembership(TOKEN_ID, DRIVE_ID)).toEqual({ role: 'ADMIN', customRoleId: null });
  });

  it('returns null when no membership row', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([]));
    expect(await getAppDriveMembership(TOKEN_ID, DRIVE_ID)).toBeNull();
  });
});

describe('getAppDriveAccessLevel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when token has no membership', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([]));
    expect(await getAppDriveAccessLevel(TOKEN_ID, DRIVE_ID)).toBeNull();
  });

  it('returns full access for OWNER/ADMIN roles', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([{ role: 'OWNER', customRoleId: null }]));
    expect(await getAppDriveAccessLevel(TOKEN_ID, DRIVE_ID)).toEqual({
      canView: true, canEdit: true, canShare: true, canDelete: true,
    });
  });

  it('returns view-only for plain MEMBER', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }]));
    expect(await getAppDriveAccessLevel(TOKEN_ID, DRIVE_ID)).toEqual({
      canView: true, canEdit: false, canShare: false, canDelete: false,
    });
  });

  it('returns driveWidePermissions (canDelete forced false) for a custom role', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(stubSelect([{ permissions: {}, driveWidePermissions: { canView: true, canEdit: true, canShare: false } }]));

    expect(await getAppDriveAccessLevel(TOKEN_ID, DRIVE_ID)).toEqual({
      canView: true, canEdit: true, canShare: false, canDelete: false,
    });
  });

  it('returns all-false for a custom role with no driveWidePermissions', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(stubSelect([{ permissions: { [PAGE_ID]: { canView: true, canEdit: true, canShare: false } }, driveWidePermissions: null }]));

    expect(await getAppDriveAccessLevel(TOKEN_ID, DRIVE_ID)).toEqual({
      canView: false, canEdit: false, canShare: false, canDelete: false,
    });
  });

  it('returns all-false for a custom role that does not resolve', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(stubSelect([]));

    expect(await getAppDriveAccessLevel(TOKEN_ID, DRIVE_ID)).toEqual({
      canView: false, canEdit: false, canShare: false, canDelete: false,
    });
  });
});

describe('getAppAccessiblePagesInDrive', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns [] when the token has no membership', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([]));
    expect(await getAppAccessiblePagesInDrive(TOKEN_ID, DRIVE_ID)).toEqual([]);
  });

  it('grants a plain MEMBER view-only access to non-private pages only', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: null }]))
      .mockReturnValueOnce(stubSelectList([
        { id: 'p1', title: 'A', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false },
        { id: 'p2', title: 'B', type: 'DOCUMENT', parentId: null, position: 1, isTrashed: false },
      ]));

    const result = await getAppAccessiblePagesInDrive(TOKEN_ID, DRIVE_ID);
    expect(result).toHaveLength(2);
    expect(result.every((p) => p.permissions.canView)).toBe(true);
    expect(result.every((p) => !p.permissions.canEdit)).toBe(true);
    expect(eq).toHaveBeenCalledWith('isPrivate', false);
  });

  it('grants an ADMIN full access to every page', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ role: 'ADMIN', customRoleId: null }]))
      .mockReturnValueOnce(stubSelectList([
        { id: 'p1', title: 'A', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false },
      ]));

    const result = await getAppAccessiblePagesInDrive(TOKEN_ID, DRIVE_ID);
    expect(result).toHaveLength(1);
    expect(result[0].permissions).toEqual({ canView: true, canEdit: true, canShare: true, canDelete: true });
  });

  it('custom role with no drive-wide view returns only explicitly granted pages', async () => {
    const perms = {
      p1: { canView: true, canEdit: true, canShare: false },
      p2: { canView: false, canEdit: false, canShare: false },
    };
    vi.mocked(db.select)
      .mockReturnValueOnce(stubSelect([{ role: 'MEMBER', customRoleId: CUSTOM_ROLE_ID }]))
      .mockReturnValueOnce(stubSelect([{ permissions: perms, driveWidePermissions: null }]))
      .mockReturnValueOnce(stubSelectList([
        { id: 'p1', title: 'A', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false },
      ]));

    const result = await getAppAccessiblePagesInDrive(TOKEN_ID, DRIVE_ID);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p1');
    expect(result[0].permissions).toEqual({ canView: true, canEdit: true, canShare: false, canDelete: false });
  });
});

describe('hasAppDriveMembership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when membership row exists', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([{ id: 'member-1' }]));
    expect(await hasAppDriveMembership(TOKEN_ID, DRIVE_ID)).toBe(true);
  });

  it('returns false when no membership row', async () => {
    vi.mocked(db.select).mockReturnValueOnce(stubSelect([]));
    expect(await hasAppDriveMembership(TOKEN_ID, DRIVE_ID)).toBe(false);
  });
});

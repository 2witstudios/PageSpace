import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: { select: vi.fn() },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', isPrivate: 'isPrivate' },
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
}));

import { getAppAccessLevel, hasAppDriveMembership } from '../app-permissions';
import { db } from '@pagespace/db/db';

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

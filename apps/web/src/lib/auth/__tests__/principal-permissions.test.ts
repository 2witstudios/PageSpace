import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserAccessLevel: vi.fn(),
  canUserViewPage: vi.fn(),
  canUserEditPage: vi.fn(),
  canUserDeletePage: vi.fn(),
  canUserSharePage: vi.fn(),
  isUserDriveMember: vi.fn(),
  isDriveOwnerOrAdmin: vi.fn(),
  getUserDriveAccess: vi.fn(),
  getDriveIdsForUser: vi.fn(),
  getUserAccessiblePagesInDriveWithDetails: vi.fn(),
  getBatchPagePermissions: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppAccessLevel: vi.fn(),
  getAppDriveMembership: vi.fn(),
  getAppDriveAccessLevel: vi.fn(),
  getAppAccessiblePagesInDrive: vi.fn(),
  hasAppDriveMembership: vi.fn(),
}));

import {
  isScopedMCPAuth,
  getPrincipalAccessLevel,
  canPrincipalViewPage,
  canPrincipalEditPage,
  canPrincipalDeletePage,
  canPrincipalSharePage,
  isPrincipalDriveMember,
  getPrincipalDriveAccess,
  isPrincipalDriveOwnerOrAdmin,
  getPrincipalDriveIds,
  getPrincipalAccessiblePagesInDrive,
  getPrincipalBatchPagePermissions,
} from '../principal-permissions';
import type { AuthResult } from '../index';
import {
  getUserAccessLevel,
  canUserViewPage,
  canUserEditPage,
  canUserDeletePage,
  canUserSharePage,
  isUserDriveMember,
  isDriveOwnerOrAdmin,
  getUserDriveAccess,
  getDriveIdsForUser,
  getUserAccessiblePagesInDriveWithDetails,
  getBatchPagePermissions,
} from '@pagespace/lib/permissions/permissions';
import {
  getAppAccessLevel,
  getAppDriveMembership,
  getAppAccessiblePagesInDrive,
  hasAppDriveMembership,
} from '@pagespace/lib/permissions/app-permissions';

const USER_ID = 'user_aaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_ID = 'tok_bbbbbbbbbbbbbbbbbbbbbb';
const PAGE_ID = 'page_cccccccccccccccccccccc';
const DRIVE_ID = 'drive_dddddddddddddddddddd';

const base = { role: 'user' as const, tokenVersion: 1, adminRoleVersion: 1 };
const sessionAuth: AuthResult = { ...base, userId: USER_ID, tokenType: 'session', sessionId: 'sess-1' };
const unscopedMcpAuth: AuthResult = { ...base, userId: USER_ID, tokenType: 'mcp', tokenId: TOKEN_ID, allowedDriveIds: [] };
const scopedMcpAuth: AuthResult = { ...base, userId: USER_ID, tokenType: 'mcp', tokenId: TOKEN_ID, allowedDriveIds: [DRIVE_ID] };

const FULL = { canView: true, canEdit: true, canShare: true, canDelete: true };
const VIEW_ONLY = { canView: true, canEdit: false, canShare: false, canDelete: false };

describe('isScopedMCPAuth', () => {
  it('is true only for MCP auth with non-empty allowedDriveIds', () => {
    expect(isScopedMCPAuth(sessionAuth)).toBe(false);
    expect(isScopedMCPAuth(unscopedMcpAuth)).toBe(false);
    expect(isScopedMCPAuth(scopedMcpAuth)).toBe(true);
  });
});

describe('dispatch matrix — page-level checks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getPrincipalAccessLevel: scoped token → app path with tokenId', async () => {
    vi.mocked(getAppAccessLevel).mockResolvedValue(VIEW_ONLY);
    expect(await getPrincipalAccessLevel(scopedMcpAuth, PAGE_ID)).toEqual(VIEW_ONLY);
    expect(getAppAccessLevel).toHaveBeenCalledWith(TOKEN_ID, PAGE_ID);
    expect(getUserAccessLevel).not.toHaveBeenCalled();
  });

  it('getPrincipalAccessLevel: unscoped token → user path', async () => {
    vi.mocked(getUserAccessLevel).mockResolvedValue(FULL);
    expect(await getPrincipalAccessLevel(unscopedMcpAuth, PAGE_ID)).toEqual(FULL);
    expect(getUserAccessLevel).toHaveBeenCalledWith(USER_ID, PAGE_ID);
    expect(getAppAccessLevel).not.toHaveBeenCalled();
  });

  it('getPrincipalAccessLevel: session → user path', async () => {
    vi.mocked(getUserAccessLevel).mockResolvedValue(FULL);
    expect(await getPrincipalAccessLevel(sessionAuth, PAGE_ID)).toEqual(FULL);
    expect(getUserAccessLevel).toHaveBeenCalledWith(USER_ID, PAGE_ID);
    expect(getAppAccessLevel).not.toHaveBeenCalled();
  });

  it('canPrincipalViewPage: scoped token uses token role, not the owning user', async () => {
    vi.mocked(getAppAccessLevel).mockResolvedValue(VIEW_ONLY);
    expect(await canPrincipalViewPage(scopedMcpAuth, PAGE_ID)).toBe(true);
    expect(canUserViewPage).not.toHaveBeenCalled();
  });

  it('canPrincipalEditPage: scoped MEMBER token is denied even though the user could edit', async () => {
    vi.mocked(getAppAccessLevel).mockResolvedValue(VIEW_ONLY);
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    expect(await canPrincipalEditPage(scopedMcpAuth, PAGE_ID)).toBe(false);
    expect(canUserEditPage).not.toHaveBeenCalled();
  });

  it('canPrincipalEditPage: scoped token denied when app access is null (outside membership)', async () => {
    vi.mocked(getAppAccessLevel).mockResolvedValue(null);
    expect(await canPrincipalEditPage(scopedMcpAuth, PAGE_ID)).toBe(false);
  });

  it('canPrincipalEditPage: unscoped token falls through to the user check', async () => {
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    expect(await canPrincipalEditPage(unscopedMcpAuth, PAGE_ID)).toBe(true);
    expect(canUserEditPage).toHaveBeenCalledWith(USER_ID, PAGE_ID);
  });

  it('canPrincipalDeletePage / canPrincipalSharePage: scoped token keyed to app flags', async () => {
    vi.mocked(getAppAccessLevel).mockResolvedValue({ ...FULL, canDelete: false, canShare: true });
    expect(await canPrincipalDeletePage(scopedMcpAuth, PAGE_ID)).toBe(false);
    expect(await canPrincipalSharePage(scopedMcpAuth, PAGE_ID)).toBe(true);
    expect(canUserDeletePage).not.toHaveBeenCalled();
    expect(canUserSharePage).not.toHaveBeenCalled();
  });
});

describe('dispatch matrix — drive-level checks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('isPrincipalDriveMember: scoped token → token membership', async () => {
    vi.mocked(hasAppDriveMembership).mockResolvedValue(true);
    expect(await isPrincipalDriveMember(scopedMcpAuth, DRIVE_ID)).toBe(true);
    expect(hasAppDriveMembership).toHaveBeenCalledWith(TOKEN_ID, DRIVE_ID);
    expect(isUserDriveMember).not.toHaveBeenCalled();
  });

  it('isPrincipalDriveMember: session → user membership', async () => {
    vi.mocked(isUserDriveMember).mockResolvedValue(false);
    expect(await isPrincipalDriveMember(sessionAuth, DRIVE_ID)).toBe(false);
    expect(isUserDriveMember).toHaveBeenCalledWith(USER_ID, DRIVE_ID);
  });

  it('getPrincipalDriveAccess: scoped token → token membership; unscoped → user access', async () => {
    vi.mocked(hasAppDriveMembership).mockResolvedValue(true);
    expect(await getPrincipalDriveAccess(scopedMcpAuth, DRIVE_ID)).toBe(true);
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);
    expect(await getPrincipalDriveAccess(unscopedMcpAuth, DRIVE_ID)).toBe(true);
    expect(getUserDriveAccess).toHaveBeenCalledWith(USER_ID, DRIVE_ID);
  });

  it('isPrincipalDriveOwnerOrAdmin: scoped token with explicit role requires OWNER/ADMIN', async () => {
    vi.mocked(getAppDriveMembership).mockResolvedValue({ role: 'MEMBER', customRoleId: null, ownerUserId: USER_ID });
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true); // owning user IS admin — must not leak through
    expect(await isPrincipalDriveOwnerOrAdmin(scopedMcpAuth, DRIVE_ID)).toBe(false);
    expect(isDriveOwnerOrAdmin).not.toHaveBeenCalled();

    vi.mocked(getAppDriveMembership).mockResolvedValue({ role: 'ADMIN', customRoleId: null, ownerUserId: USER_ID });
    expect(await isPrincipalDriveOwnerOrAdmin(scopedMcpAuth, DRIVE_ID)).toBe(true);
  });

  it('isPrincipalDriveOwnerOrAdmin: INHERITED row (role null) uses the owner\'s own authority', async () => {
    vi.mocked(getAppDriveMembership).mockResolvedValue({ role: null, customRoleId: null, ownerUserId: USER_ID });
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    expect(await isPrincipalDriveOwnerOrAdmin(scopedMcpAuth, DRIVE_ID)).toBe(true);
    expect(isDriveOwnerOrAdmin).toHaveBeenCalledWith(USER_ID, DRIVE_ID);

    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(false);
    expect(await isPrincipalDriveOwnerOrAdmin(scopedMcpAuth, DRIVE_ID)).toBe(false);
  });

  it('isPrincipalDriveOwnerOrAdmin: no membership row → false (no user fallback)', async () => {
    vi.mocked(getAppDriveMembership).mockResolvedValue(null);
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    expect(await isPrincipalDriveOwnerOrAdmin(scopedMcpAuth, DRIVE_ID)).toBe(false);
    expect(isDriveOwnerOrAdmin).not.toHaveBeenCalled();
  });

  it('getPrincipalDriveIds: scoped token → its allowedDriveIds, NOT the user drive list', async () => {
    vi.mocked(getDriveIdsForUser).mockResolvedValue(['other-drive']);
    expect(await getPrincipalDriveIds(scopedMcpAuth)).toEqual([DRIVE_ID]);
    expect(getDriveIdsForUser).not.toHaveBeenCalled();

    expect(await getPrincipalDriveIds(unscopedMcpAuth)).toEqual(['other-drive']);
    expect(getDriveIdsForUser).toHaveBeenCalledWith(USER_ID);
  });

  it('getPrincipalAccessiblePagesInDrive: dispatches per principal', async () => {
    vi.mocked(getAppAccessiblePagesInDrive).mockResolvedValue([]);
    await getPrincipalAccessiblePagesInDrive(scopedMcpAuth, DRIVE_ID);
    expect(getAppAccessiblePagesInDrive).toHaveBeenCalledWith(TOKEN_ID, DRIVE_ID);

    vi.mocked(getUserAccessiblePagesInDriveWithDetails).mockResolvedValue([]);
    await getPrincipalAccessiblePagesInDrive(sessionAuth, DRIVE_ID);
    expect(getUserAccessiblePagesInDriveWithDetails).toHaveBeenCalledWith(USER_ID, DRIVE_ID);
  });
});

describe('getPrincipalBatchPagePermissions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('session/unscoped → user batch path', async () => {
    const expected = new Map([[PAGE_ID, FULL]]);
    vi.mocked(getBatchPagePermissions).mockResolvedValue(expected);
    expect(await getPrincipalBatchPagePermissions(sessionAuth, [PAGE_ID])).toBe(expected);
    expect(getBatchPagePermissions).toHaveBeenCalledWith(USER_ID, [PAGE_ID]);
  });

  it('scoped token → resolves from the token-accessible page sets, denying everything else', async () => {
    vi.mocked(getAppAccessiblePagesInDrive).mockResolvedValue([
      { id: PAGE_ID, title: 'A', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false, permissions: VIEW_ONLY },
    ]);

    const result = await getPrincipalBatchPagePermissions(scopedMcpAuth, [PAGE_ID, 'page_outside']);
    expect(result.get(PAGE_ID)).toEqual(VIEW_ONLY);
    expect(result.get('page_outside')).toEqual({ canView: false, canEdit: false, canShare: false, canDelete: false });
    expect(getBatchPagePermissions).not.toHaveBeenCalled();
  });

  it('scoped token with empty input returns an empty map without queries', async () => {
    const result = await getPrincipalBatchPagePermissions(scopedMcpAuth, []);
    expect(result.size).toBe(0);
    expect(getAppAccessiblePagesInDrive).not.toHaveBeenCalled();
  });
});

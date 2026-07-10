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
  getScopedAccessLevel: vi.fn(),
  getScopedDriveMembership: vi.fn(),
  getScopedDriveAccessLevel: vi.fn(),
  getScopedAccessiblePagesInDrive: vi.fn(),
  hasScopedDriveMembership: vi.fn(),
}));

import {
  isScopedMCPAuth,
  isScopedOAuthAuth,
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
  getScopedAccessLevel,
  getScopedDriveMembership,
  getScopedAccessiblePagesInDrive,
  hasScopedDriveMembership,
} from '@pagespace/lib/permissions/app-permissions';
import { manageKeysScopedAuthResult } from './manage-keys-fixture';
import type { AuthResult } from '@/lib/auth/auth-types';

const USER_ID = 'user_aaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_ID = 'tok_bbbbbbbbbbbbbbbbbbbbbb';
const PAGE_ID = 'page_cccccccccccccccccccccc';
const DRIVE_ID = 'drive_dddddddddddddddddddd';

const base = { role: 'user' as const, tokenVersion: 1, adminRoleVersion: 1 };
const sessionAuth: AuthResult = { ...base, userId: USER_ID, tokenType: 'session', sessionId: 'sess-1' };
const unscopedMcpAuth: AuthResult = { ...base, userId: USER_ID, tokenType: 'mcp', tokenId: TOKEN_ID, allowedDriveIds: [] };
const scopedMcpAuth: AuthResult = { ...base, userId: USER_ID, tokenType: 'mcp', tokenId: TOKEN_ID, allowedDriveIds: [DRIVE_ID] };

const DRIVE_SCOPES = [{ driveId: DRIVE_ID, role: null, customRoleId: null }];
const accountOAuthAuth: AuthResult = {
  ...base, userId: USER_ID, tokenType: 'oauth', tokenId: TOKEN_ID,
  scopes: { account: true, offlineAccess: false, drives: new Map(), manageKeys: false, allDrives: false, updateKeyId: null, activateKeyId: null, newKeyName: null },
  driveScopes: [], allowedDriveIds: [],
};
const scopedOAuthAuth: AuthResult = {
  ...base, userId: USER_ID, tokenType: 'oauth', tokenId: TOKEN_ID,
  scopes: { account: false, offlineAccess: false, drives: new Map([[DRIVE_ID, { kind: 'drive' as const, driveId: DRIVE_ID, role: { kind: 'inherit' as const } }]]), manageKeys: false, allDrives: false, updateKeyId: null, activateKeyId: null, newKeyName: null },
  driveScopes: DRIVE_SCOPES, allowedDriveIds: [DRIVE_ID],
};

const FULL = { canView: true, canEdit: true, canShare: true, canDelete: true };
const VIEW_ONLY = { canView: true, canEdit: false, canShare: false, canDelete: false };

describe('isScopedMCPAuth', () => {
  it('is true only for MCP auth with non-empty allowedDriveIds', () => {
    expect(isScopedMCPAuth(sessionAuth)).toBe(false);
    expect(isScopedMCPAuth(unscopedMcpAuth)).toBe(false);
    expect(isScopedMCPAuth(scopedMcpAuth)).toBe(true);
  });

  it('is false for OAuth auth (even drive-scoped)', () => {
    expect(isScopedMCPAuth(accountOAuthAuth)).toBe(false);
    expect(isScopedMCPAuth(scopedOAuthAuth)).toBe(false);
  });
});

describe('isScopedOAuthAuth', () => {
  it('is true only for OAuth auth without the account scope', () => {
    expect(isScopedOAuthAuth(sessionAuth)).toBe(false);
    expect(isScopedOAuthAuth(unscopedMcpAuth)).toBe(false);
    expect(isScopedOAuthAuth(scopedMcpAuth)).toBe(false);
    expect(isScopedOAuthAuth(accountOAuthAuth)).toBe(false);
    expect(isScopedOAuthAuth(scopedOAuthAuth)).toBe(true);
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

  it('getPrincipalAccessLevel: drive-scoped OAuth token → scoped path with driveScopes+userId, indistinguishable from a scoped MCP token', async () => {
    vi.mocked(getScopedAccessLevel).mockResolvedValue(VIEW_ONLY);
    expect(await getPrincipalAccessLevel(scopedOAuthAuth, PAGE_ID)).toEqual(VIEW_ONLY);
    expect(getScopedAccessLevel).toHaveBeenCalledWith(DRIVE_SCOPES, USER_ID, PAGE_ID);
    expect(getUserAccessLevel).not.toHaveBeenCalled();
    expect(getAppAccessLevel).not.toHaveBeenCalled();
  });

  it('getPrincipalAccessLevel: account-scoped OAuth token → user path (full-user credential, like an unscoped MCP token)', async () => {
    vi.mocked(getUserAccessLevel).mockResolvedValue(FULL);
    expect(await getPrincipalAccessLevel(accountOAuthAuth, PAGE_ID)).toEqual(FULL);
    expect(getUserAccessLevel).toHaveBeenCalledWith(USER_ID, PAGE_ID);
    expect(getScopedAccessLevel).not.toHaveBeenCalled();
  });

  it('canPrincipalEditPage: scoped OAuth MEMBER-equivalent denied even though the user could edit', async () => {
    vi.mocked(getScopedAccessLevel).mockResolvedValue(VIEW_ONLY);
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    expect(await canPrincipalEditPage(scopedOAuthAuth, PAGE_ID)).toBe(false);
    expect(canUserEditPage).not.toHaveBeenCalled();
  });

  it('canPrincipalDeletePage / canPrincipalSharePage: scoped OAuth token keyed to scoped-app flags', async () => {
    vi.mocked(getScopedAccessLevel).mockResolvedValue({ ...FULL, canDelete: false, canShare: true });
    expect(await canPrincipalDeletePage(scopedOAuthAuth, PAGE_ID)).toBe(false);
    expect(await canPrincipalSharePage(scopedOAuthAuth, PAGE_ID)).toBe(true);
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

  it('isPrincipalDriveMember: drive-scoped OAuth token → scoped membership via driveScopes+userId', async () => {
    vi.mocked(hasScopedDriveMembership).mockResolvedValue(true);
    expect(await isPrincipalDriveMember(scopedOAuthAuth, DRIVE_ID)).toBe(true);
    expect(hasScopedDriveMembership).toHaveBeenCalledWith(DRIVE_SCOPES, USER_ID, DRIVE_ID);
    expect(isUserDriveMember).not.toHaveBeenCalled();
  });

  it('getPrincipalDriveAccess: account-scoped OAuth token → user access (full-user credential)', async () => {
    vi.mocked(getUserDriveAccess).mockResolvedValue(true);
    expect(await getPrincipalDriveAccess(accountOAuthAuth, DRIVE_ID)).toBe(true);
    expect(getUserDriveAccess).toHaveBeenCalledWith(USER_ID, DRIVE_ID);
  });

  it('isPrincipalDriveOwnerOrAdmin: scoped OAuth token with explicit ADMIN role → true; MEMBER → false', async () => {
    vi.mocked(getScopedDriveMembership).mockReturnValue({ role: 'MEMBER', customRoleId: null });
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true); // owning user IS admin — must not leak through
    expect(await isPrincipalDriveOwnerOrAdmin(scopedOAuthAuth, DRIVE_ID)).toBe(false);
    expect(isDriveOwnerOrAdmin).not.toHaveBeenCalled();

    vi.mocked(getScopedDriveMembership).mockReturnValue({ role: 'ADMIN', customRoleId: null });
    expect(await isPrincipalDriveOwnerOrAdmin(scopedOAuthAuth, DRIVE_ID)).toBe(true);
  });

  it('isPrincipalDriveOwnerOrAdmin: INHERITED OAuth scope row (role null) uses the owner\'s own authority', async () => {
    vi.mocked(getScopedDriveMembership).mockReturnValue({ role: null, customRoleId: null });
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    expect(await isPrincipalDriveOwnerOrAdmin(scopedOAuthAuth, DRIVE_ID)).toBe(true);
    expect(isDriveOwnerOrAdmin).toHaveBeenCalledWith(USER_ID, DRIVE_ID);
  });

  it('isPrincipalDriveOwnerOrAdmin: no matching OAuth scope row → false (no user fallback)', async () => {
    vi.mocked(getScopedDriveMembership).mockReturnValue(null);
    vi.mocked(isDriveOwnerOrAdmin).mockResolvedValue(true);
    expect(await isPrincipalDriveOwnerOrAdmin(scopedOAuthAuth, DRIVE_ID)).toBe(false);
    expect(isDriveOwnerOrAdmin).not.toHaveBeenCalled();
  });

  it('getPrincipalDriveIds: drive-scoped OAuth token → its allowedDriveIds, NOT the user drive list', async () => {
    vi.mocked(getDriveIdsForUser).mockResolvedValue(['other-drive']);
    expect(await getPrincipalDriveIds(scopedOAuthAuth)).toEqual([DRIVE_ID]);
    expect(getDriveIdsForUser).not.toHaveBeenCalled();
  });

  it('getPrincipalAccessiblePagesInDrive: drive-scoped OAuth token dispatches to getScopedAccessiblePagesInDrive', async () => {
    vi.mocked(getScopedAccessiblePagesInDrive).mockResolvedValue([]);
    await getPrincipalAccessiblePagesInDrive(scopedOAuthAuth, DRIVE_ID);
    expect(getScopedAccessiblePagesInDrive).toHaveBeenCalledWith(DRIVE_SCOPES, USER_ID, DRIVE_ID);
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

  it('drive-scoped OAuth token → resolves via getScopedAccessiblePagesInDrive, denying everything else', async () => {
    vi.mocked(getScopedAccessiblePagesInDrive).mockResolvedValue([
      { id: PAGE_ID, title: 'A', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false, permissions: VIEW_ONLY },
    ]);

    const result = await getPrincipalBatchPagePermissions(scopedOAuthAuth, [PAGE_ID, 'page_outside']);
    expect(result.get(PAGE_ID)).toEqual(VIEW_ONLY);
    expect(result.get('page_outside')).toEqual({ canView: false, canEdit: false, canShare: false, canDelete: false });
    expect(getScopedAccessiblePagesInDrive).toHaveBeenCalledWith(DRIVE_SCOPES, USER_ID, DRIVE_ID);
    expect(getBatchPagePermissions).not.toHaveBeenCalled();
  });

  it('account-scoped OAuth token → user batch path (full-user credential)', async () => {
    const expected = new Map([[PAGE_ID, FULL]]);
    vi.mocked(getBatchPagePermissions).mockResolvedValue(expected);
    expect(await getPrincipalBatchPagePermissions(accountOAuthAuth, [PAGE_ID])).toBe(expected);
    expect(getBatchPagePermissions).toHaveBeenCalledWith(USER_ID, [PAGE_ID]);
  });
});

// =============================================================================
// MANAGE-KEYS-ONLY CREDENTIAL — deny-first short-circuit
// =============================================================================
//
// isScopedOAuthAuth returns true for a manage-keys-only credential too
// (scopes.account is false), so absent an explicit guard every function here
// would dispatch to the scoped/app path — which today happens to deny
// because driveScopes/allowedDriveIds are empty for a well-formed manage-keys
// credential. That's caller convention, not a guarantee this module itself
// provides: a credential violating the manage_keys/account exclusivity
// invariant (e.g. a future bug producing account:true + manageKeys:true) has
// `!auth.scopes.account` false, so isScopedOAuthAuth is false too, and it
// would fall through to the "acts as the user" branch — full unrestricted
// access. These tests pin down that the explicit isManageKeysOnly check
// denies first, regardless of the other scope fields.
describe('manage-keys-only credential — deny-first short-circuit', () => {
  beforeEach(() => vi.clearAllMocks());

  const manageKeysAuth = manageKeysScopedAuthResult();

  // Simulates a future invariant violation: manageKeys + account both true,
  // plus a non-empty allowedDriveIds — proves the guard doesn't rely on
  // scopes.account being false or allowedDriveIds being empty.
  const brokenManageKeysAuth = manageKeysScopedAuthResult({
    scopes: { account: true, offlineAccess: false, drives: new Map(), manageKeys: true, allDrives: false, updateKeyId: null, activateKeyId: null, newKeyName: null },
    allowedDriveIds: ['drive-should-never-be-reachable'],
  });

  const cases: Array<[string, AuthResult]> = [
    ['well-formed manage-keys credential', manageKeysAuth],
    ['invariant-violated manage-keys credential (account=true, non-empty allowedDriveIds)', brokenManageKeysAuth],
  ];

  it.each(cases)('getPrincipalAccessLevel denies (%s)', async (_label, auth) => {
    expect(await getPrincipalAccessLevel(auth, PAGE_ID)).toBeNull();
    expect(getUserAccessLevel).not.toHaveBeenCalled();
    expect(getAppAccessLevel).not.toHaveBeenCalled();
    expect(getScopedAccessLevel).not.toHaveBeenCalled();
  });

  it.each(cases)('canPrincipalViewPage denies (%s)', async (_label, auth) => {
    expect(await canPrincipalViewPage(auth, PAGE_ID)).toBe(false);
    expect(canUserViewPage).not.toHaveBeenCalled();
  });

  it.each(cases)('canPrincipalEditPage denies (%s)', async (_label, auth) => {
    expect(await canPrincipalEditPage(auth, PAGE_ID)).toBe(false);
    expect(canUserEditPage).not.toHaveBeenCalled();
  });

  it.each(cases)('canPrincipalDeletePage denies (%s)', async (_label, auth) => {
    expect(await canPrincipalDeletePage(auth, PAGE_ID)).toBe(false);
    expect(canUserDeletePage).not.toHaveBeenCalled();
  });

  it.each(cases)('canPrincipalSharePage denies (%s)', async (_label, auth) => {
    expect(await canPrincipalSharePage(auth, PAGE_ID)).toBe(false);
    expect(canUserSharePage).not.toHaveBeenCalled();
  });

  it.each(cases)('isPrincipalDriveMember denies (%s)', async (_label, auth) => {
    expect(await isPrincipalDriveMember(auth, DRIVE_ID)).toBe(false);
    expect(isUserDriveMember).not.toHaveBeenCalled();
    expect(hasAppDriveMembership).not.toHaveBeenCalled();
    expect(hasScopedDriveMembership).not.toHaveBeenCalled();
  });

  it.each(cases)('isPrincipalDriveOwnerOrAdmin denies (%s)', async (_label, auth) => {
    expect(await isPrincipalDriveOwnerOrAdmin(auth, DRIVE_ID)).toBe(false);
    expect(isDriveOwnerOrAdmin).not.toHaveBeenCalled();
    expect(getAppDriveMembership).not.toHaveBeenCalled();
    expect(getScopedDriveMembership).not.toHaveBeenCalled();
  });

  it.each(cases)('getPrincipalDriveIds returns empty, never the owning user\'s drive list (%s)', async (_label, auth) => {
    expect(await getPrincipalDriveIds(auth)).toEqual([]);
    expect(getDriveIdsForUser).not.toHaveBeenCalled();
  });

  it.each(cases)('getPrincipalDriveAccess denies (%s)', async (_label, auth) => {
    expect(await getPrincipalDriveAccess(auth, DRIVE_ID)).toBe(false);
    expect(getUserDriveAccess).not.toHaveBeenCalled();
    expect(hasAppDriveMembership).not.toHaveBeenCalled();
    expect(hasScopedDriveMembership).not.toHaveBeenCalled();
  });

  it.each(cases)('getPrincipalAccessiblePagesInDrive returns empty, never the owning user\'s pages (%s)', async (_label, auth) => {
    expect(await getPrincipalAccessiblePagesInDrive(auth, DRIVE_ID)).toEqual([]);
    expect(getUserAccessiblePagesInDriveWithDetails).not.toHaveBeenCalled();
    expect(getAppAccessiblePagesInDrive).not.toHaveBeenCalled();
    expect(getScopedAccessiblePagesInDrive).not.toHaveBeenCalled();
  });

  it.each(cases)('getPrincipalBatchPagePermissions denies every requested page, never the owning user\'s batch (%s)', async (_label, auth) => {
    const result = await getPrincipalBatchPagePermissions(auth, [PAGE_ID]);
    expect(result.get(PAGE_ID)).toEqual({ canView: false, canEdit: false, canShare: false, canDelete: false });
    expect(getBatchPagePermissions).not.toHaveBeenCalled();
    expect(getAppAccessiblePagesInDrive).not.toHaveBeenCalled();
    expect(getScopedAccessiblePagesInDrive).not.toHaveBeenCalled();
  });
});

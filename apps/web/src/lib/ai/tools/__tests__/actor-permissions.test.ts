import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockHasAgentDriveMembership,
  mockCheckDriveAccess,
  mockGetUserDriveAccess,
  mockGetAgentAccessLevel,
  mockDbWhere,
  mockGetAppAccessLevel,
  mockGetAppDriveMembership,
  mockGetAppDriveAccessLevel,
  mockGetAppAccessiblePagesInDrive,
} = vi.hoisted(() => ({
  mockHasAgentDriveMembership: vi.fn(),
  mockCheckDriveAccess: vi.fn(),
  mockGetUserDriveAccess: vi.fn(),
  mockGetAgentAccessLevel: vi.fn(),
  mockDbWhere: vi.fn(),
  mockGetAppAccessLevel: vi.fn(),
  mockGetAppDriveMembership: vi.fn(),
  mockGetAppDriveAccessLevel: vi.fn(),
  mockGetAppAccessiblePagesInDrive: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserAccessLevel: vi.fn(),
  getUserDriveAccess: mockGetUserDriveAccess,
  canUserEditPage: vi.fn(),
  canUserDeletePage: vi.fn(),
  getUserAccessiblePagesInDriveWithDetails: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/agent-permissions', () => ({
  getAgentAccessLevel: mockGetAgentAccessLevel,
  getAgentAccessiblePagesInDrive: vi.fn(),
  hasAgentDriveMembership: mockHasAgentDriveMembership,
}));
vi.mock('@pagespace/lib/permissions/app-permissions', () => ({
  getAppAccessLevel: mockGetAppAccessLevel,
  getAppDriveMembership: mockGetAppDriveMembership,
  getAppDriveAccessLevel: mockGetAppDriveAccessLevel,
  getAppAccessiblePagesInDrive: mockGetAppAccessiblePagesInDrive,
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  checkDriveAccess: mockCheckDriveAccess,
}));
vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: mockDbWhere }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: { id: 'id', driveId: 'driveId' } }));

import {
  canActorManageDrive,
  canActorAccessDrive,
  canActorEditPage,
  canActorViewPage,
  getActorAccessiblePagesInDrive,
  filterDriveIdsByMcpScope,
  driveOutsideMcpScope,
  driveDeniedByAppToken,
  filterDriveIdsByAppTokenScope,
} from '../actor-permissions';
import type { ToolExecutionContext } from '../../core/types';

const DRIVE = 'drive-1';
const userCtx = { userId: 'user-1' } as ToolExecutionContext;
const agentCtx = {
  userId: 'user-1',
  chatSource: { type: 'page', agentPageId: 'agent-1' },
} as ToolExecutionContext;

describe('canActorManageDrive', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows a drive owner', async () => {
    mockCheckDriveAccess.mockResolvedValue({ isOwner: true, isAdmin: true, isMember: true });
    expect(await canActorManageDrive(userCtx, DRIVE)).toBe(true);
  });

  it('allows a drive admin', async () => {
    mockCheckDriveAccess.mockResolvedValue({ isOwner: false, isAdmin: true, isMember: true });
    expect(await canActorManageDrive(userCtx, DRIVE)).toBe(true);
  });

  it('denies a plain member (not owner/admin) — the privilege-escalation guard', async () => {
    mockCheckDriveAccess.mockResolvedValue({ isOwner: false, isAdmin: false, isMember: true });
    expect(await canActorManageDrive(userCtx, DRIVE)).toBe(false);
    expect(mockHasAgentDriveMembership).not.toHaveBeenCalled();
  });

  it('denies a user with no access', async () => {
    mockCheckDriveAccess.mockResolvedValue({ isOwner: false, isAdmin: false, isMember: false });
    expect(await canActorManageDrive(userCtx, DRIVE)).toBe(false);
  });

  it('gates an agent actor on drive membership, not owner/admin', async () => {
    mockHasAgentDriveMembership.mockResolvedValue(true);
    expect(await canActorManageDrive(agentCtx, DRIVE)).toBe(true);
    expect(mockHasAgentDriveMembership).toHaveBeenCalledWith('agent-1', DRIVE);
    expect(mockCheckDriveAccess).not.toHaveBeenCalled();
  });

  it('denies an agent that is not a drive member', async () => {
    mockHasAgentDriveMembership.mockResolvedValue(false);
    expect(await canActorManageDrive(agentCtx, DRIVE)).toBe(false);
  });
});

describe('MCP drive-scope enforcement', () => {
  beforeEach(() => vi.clearAllMocks());

  // A scoped MCP token acting as an agent that DOES have access to the target.
  const scopedAgentCtx = {
    userId: 'user-1',
    chatSource: { type: 'page', agentPageId: 'agent-1' },
    mcpAllowedDriveIds: ['drive-A'],
  } as ToolExecutionContext;

  it('canActorAccessDrive: denies a drive outside the token scope before any ACL check', async () => {
    expect(await canActorAccessDrive(scopedAgentCtx, 'drive-B')).toBe(false);
    // Fails closed at the scope ceiling — the agent ACL is never consulted.
    expect(mockHasAgentDriveMembership).not.toHaveBeenCalled();
  });

  it('canActorAccessDrive: allows an in-scope drive (then defers to the agent ACL)', async () => {
    mockHasAgentDriveMembership.mockResolvedValue(true);
    expect(await canActorAccessDrive(scopedAgentCtx, 'drive-A')).toBe(true);
    expect(mockHasAgentDriveMembership).toHaveBeenCalledWith('agent-1', 'drive-A');
  });

  it('canActorEditPage: denies when the page lives in a drive outside the token scope', async () => {
    mockDbWhere.mockResolvedValue([{ driveId: 'drive-B' }]);
    expect(await canActorEditPage(scopedAgentCtx, 'page-x')).toBe(false);
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorEditPage: denies an unknown id that is neither a page nor an allowed drive', async () => {
    mockDbWhere.mockResolvedValue([]);
    expect(await canActorEditPage(scopedAgentCtx, 'missing-page')).toBe(false);
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorEditPage: root-create path — an in-scope drive id with no page row is allowed', async () => {
    // create_page passes the DRIVE id to canActorEditPage for root-level creates.
    mockDbWhere.mockResolvedValue([]); // no page row for a drive id
    mockGetAgentAccessLevel.mockResolvedValue({ canEdit: true });
    expect(await canActorEditPage(scopedAgentCtx, 'drive-A')).toBe(true);
    // The scope ceiling passed (drive-A is in scope), so the agent ACL was consulted.
    expect(mockGetAgentAccessLevel).toHaveBeenCalledWith('agent-1', 'drive-A');
  });

  it('canActorEditPage: allows an in-scope page (then defers to the agent ACL)', async () => {
    mockDbWhere.mockResolvedValue([{ driveId: 'drive-A' }]);
    mockGetAgentAccessLevel.mockResolvedValue({ canEdit: true });
    expect(await canActorEditPage(scopedAgentCtx, 'page-y')).toBe(true);
  });

  it('unscoped caller (no mcpAllowedDriveIds) skips scope checks entirely', async () => {
    const unscoped = { userId: 'user-1', mcpAllowedDriveIds: [] } as ToolExecutionContext;
    mockGetUserDriveAccess.mockResolvedValue(true);
    expect(await canActorAccessDrive(unscoped, 'drive-B')).toBe(true);
    // No page-drive lookup happens for drive-level checks.
    expect(mockDbWhere).not.toHaveBeenCalled();
  });
});

describe('app-member RBAC ceiling (mcpTokenId set)', () => {
  beforeEach(() => vi.clearAllMocks());

  const VIEW_ONLY = { canView: true, canEdit: false, canShare: false, canDelete: false };
  const FULL = { canView: true, canEdit: true, canShare: true, canDelete: true };

  // Scoped token driving an agent whose own ACL would allow everything.
  const tokenAgentCtx = {
    userId: 'user-1',
    chatSource: { type: 'page', agentPageId: 'agent-1' },
    mcpAllowedDriveIds: ['drive-A'],
    mcpTokenId: 'token-1',
  } as ToolExecutionContext;

  // Scoped token acting directly as the user (global assistant via MCP).
  const tokenUserCtx = {
    userId: 'user-1',
    mcpAllowedDriveIds: ['drive-A'],
    mcpTokenId: 'token-1',
  } as ToolExecutionContext;

  it('canActorEditPage: explicit MEMBER token (view-only page) is denied even when the agent ACL allows edit', async () => {
    mockDbWhere.mockResolvedValue([{ driveId: 'drive-A' }]);
    mockGetAppDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: null, ownerUserId: 'user-1' });
    mockGetAppAccessLevel.mockResolvedValue(VIEW_ONLY);
    mockGetAgentAccessLevel.mockResolvedValue(FULL);

    expect(await canActorEditPage(tokenAgentCtx, 'page-x')).toBe(false);
    expect(mockGetAppAccessLevel).toHaveBeenCalledWith('token-1', 'page-x');
    // Denied at the token ceiling — agent ACL never consulted.
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorEditPage: INHERITED token (role null) applies no ceiling — agent ACL decides', async () => {
    mockDbWhere.mockResolvedValue([{ driveId: 'drive-A' }]);
    mockGetAppDriveMembership.mockResolvedValue({ role: null, customRoleId: null, ownerUserId: 'user-1' });
    mockGetAgentAccessLevel.mockResolvedValue(FULL);

    expect(await canActorEditPage(tokenAgentCtx, 'page-x')).toBe(true);
    // No ceiling lookup for inherited rows.
    expect(mockGetAppAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorEditPage: explicit ADMIN token falls through to the agent ACL (deny-only, never grants)', async () => {
    mockDbWhere.mockResolvedValue([{ driveId: 'drive-A' }]);
    mockGetAppDriveMembership.mockResolvedValue({ role: 'ADMIN', customRoleId: null, ownerUserId: 'user-1' });
    mockGetAppAccessLevel.mockResolvedValue(FULL);
    mockGetAgentAccessLevel.mockResolvedValue({ ...FULL, canEdit: false });

    // Token allows edit but the agent's own ACL does not — still denied.
    expect(await canActorEditPage(tokenAgentCtx, 'page-x')).toBe(false);
    expect(mockGetAgentAccessLevel).toHaveBeenCalledWith('agent-1', 'page-x');
  });

  it('canActorViewPage: explicit-role token outside its page access (null level) is denied', async () => {
    mockDbWhere.mockResolvedValue([{ driveId: 'drive-A' }]);
    mockGetAppDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: null, ownerUserId: 'user-1' });
    mockGetAppAccessLevel.mockResolvedValue(null);

    expect(await canActorViewPage(tokenUserCtx, 'page-x')).toBe(false);
  });

  it('contexts without mcpTokenId keep the scope-only behavior (no app-permission lookups)', async () => {
    const legacyScopedCtx = {
      userId: 'user-1',
      chatSource: { type: 'page', agentPageId: 'agent-1' },
      mcpAllowedDriveIds: ['drive-A'],
    } as ToolExecutionContext;
    mockDbWhere.mockResolvedValue([{ driveId: 'drive-A' }]);
    mockGetAgentAccessLevel.mockResolvedValue(FULL);

    expect(await canActorEditPage(legacyScopedCtx, 'page-x')).toBe(true);
    expect(mockGetAppAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorManageDrive: MEMBER-role token is denied manage even when the user is the owner', async () => {
    mockGetAppDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: null });
    mockCheckDriveAccess.mockResolvedValue({ isOwner: true, isAdmin: true, isMember: true });

    expect(await canActorManageDrive(tokenUserCtx, 'drive-A')).toBe(false);
    expect(mockCheckDriveAccess).not.toHaveBeenCalled();
  });

  it('canActorManageDrive: ADMIN-role token falls through to the actor check', async () => {
    mockGetAppDriveMembership.mockResolvedValue({ role: 'ADMIN', customRoleId: null });
    mockCheckDriveAccess.mockResolvedValue({ isOwner: true, isAdmin: true, isMember: true });

    expect(await canActorManageDrive(tokenUserCtx, 'drive-A')).toBe(true);
  });

  it('getActorAccessiblePagesInDrive: explicit role intersects actor pages with the token set, AND-ing flags', async () => {
    mockGetAppDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: null, ownerUserId: 'user-1' });
    const { getUserAccessiblePagesInDriveWithDetails } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(getUserAccessiblePagesInDriveWithDetails).mockResolvedValue([
      { id: 'p1', title: 'A', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false, permissions: { ...FULL } },
      { id: 'p2', title: 'B', type: 'DOCUMENT', parentId: null, position: 1, isTrashed: false, permissions: { ...FULL } },
    ]);
    mockGetAppAccessiblePagesInDrive.mockResolvedValue([
      { id: 'p1', title: 'A', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false, permissions: { ...VIEW_ONLY } },
      // p2 absent — token cannot see it at all.
    ]);

    const result = await getActorAccessiblePagesInDrive(tokenUserCtx, 'drive-A');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p1');
    expect(result[0].permissions).toEqual(VIEW_ONLY);
  });

  it('driveDeniedByAppToken: role-aware drive gate (view/edit/manage, inherit no-op)', async () => {
    mockGetAppDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: null, ownerUserId: 'user-1' });
    // User drive-root parity: explicit MEMBER may view AND edit (create events/root pages)…
    mockGetAppDriveAccessLevel.mockResolvedValue({ ...VIEW_ONLY, canEdit: true });
    expect(await driveDeniedByAppToken(tokenUserCtx, 'drive-A', 'view')).toBe(false);
    expect(await driveDeniedByAppToken(tokenUserCtx, 'drive-A', 'edit')).toBe(false);
    // …but not manage.
    expect(await driveDeniedByAppToken(tokenUserCtx, 'drive-A', 'manage')).toBe(true);

    // Inherited membership: no ceiling at any level.
    mockGetAppDriveMembership.mockResolvedValue({ role: null, customRoleId: null, ownerUserId: 'user-1' });
    expect(await driveDeniedByAppToken(tokenUserCtx, 'drive-A', 'manage')).toBe(false);

    // Out-of-scope drive denied before any role lookup.
    expect(await driveDeniedByAppToken(tokenUserCtx, 'drive-B', 'view')).toBe(true);
  });

  it('filterDriveIdsByAppTokenScope: drops drives where the token has no usable membership', async () => {
    const ctx = {
      userId: 'user-1',
      mcpAllowedDriveIds: ['drive-A', 'drive-B'],
      mcpTokenId: 'token-1',
    } as ToolExecutionContext;
    // drive-A: explicit membership (kept); drive-B: dangling row (dropped).
    mockGetAppDriveMembership.mockImplementation(async (_t: string, driveId: string) =>
      driveId === 'drive-A' ? { role: 'MEMBER', customRoleId: null, ownerUserId: 'user-1' } : null);
    mockGetAppDriveAccessLevel.mockResolvedValue({ ...VIEW_ONLY, canEdit: true });

    expect(await filterDriveIdsByAppTokenScope(ctx, ['drive-A', 'drive-B', 'drive-C'])).toEqual(['drive-A']);
  });

  it('filterDriveIdsByAppTokenScope: unscoped/legacy contexts pass through', async () => {
    const unscoped = { userId: 'u' } as ToolExecutionContext;
    expect(await filterDriveIdsByAppTokenScope(unscoped, ['a', 'b'])).toEqual(['a', 'b']);
    expect(mockGetAppDriveAccessLevel).not.toHaveBeenCalled();
  });
});

describe('filterDriveIdsByMcpScope / driveOutsideMcpScope', () => {
  const scoped = { userId: 'u', mcpAllowedDriveIds: ['a', 'b'] } as ToolExecutionContext;
  const unscoped = { userId: 'u' } as ToolExecutionContext;

  it('filters a drive list down to the token scope', () => {
    expect(filterDriveIdsByMcpScope(scoped, ['a', 'c', 'b', 'd'])).toEqual(['a', 'b']);
  });

  it('returns the list unchanged for an unscoped caller', () => {
    expect(filterDriveIdsByMcpScope(unscoped, ['a', 'c'])).toEqual(['a', 'c']);
  });

  it('driveOutsideMcpScope: true for out-of-scope, false for in-scope and unscoped', () => {
    expect(driveOutsideMcpScope(scoped, 'c')).toBe(true);
    expect(driveOutsideMcpScope(scoped, 'a')).toBe(false);
    expect(driveOutsideMcpScope(unscoped, 'c')).toBe(false);
  });
});

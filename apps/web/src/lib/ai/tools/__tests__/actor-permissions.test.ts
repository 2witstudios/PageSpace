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
  mockGetScopedAccessLevel,
  mockGetScopedDriveMembership,
  mockGetScopedAccessiblePagesInDrive,
  mockHasScopedDriveMembership,
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
  mockGetScopedAccessLevel: vi.fn(),
  mockGetScopedDriveMembership: vi.fn(),
  mockGetScopedAccessiblePagesInDrive: vi.fn(),
  mockHasScopedDriveMembership: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  // The ceiling's owner/admin bar asks the user's live standing too; the
  // fixtures' users are owners unless a test says otherwise.
  isDriveOwnerOrAdmin: vi.fn(async () => true),
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
  getScopedAccessLevel: mockGetScopedAccessLevel,
  getScopedDriveMembership: mockGetScopedDriveMembership,
  getScopedAccessiblePagesInDrive: mockGetScopedAccessiblePagesInDrive,
  hasScopedDriveMembership: mockHasScopedDriveMembership,
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  checkDriveAccess: mockCheckDriveAccess,
}));
vi.mock('@pagespace/db/db', () => ({
  db: { select: () => ({ from: () => ({ where: mockDbWhere }) }) },
}));
vi.mock('@pagespace/db/operators', () => ({ eq: vi.fn() }));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', type: 'type', userScopedAccess: 'userScopedAccess', parentId: 'parentId' },
}));

import {
  canActorManageDrive,
  canActorAccessDrive,
  canActorEditPage,
  canActorDeletePage,
  canActorViewPage,
  canActorConsultAgent,
  getActorAccessiblePagesInDrive,
  filterDriveIdsByMcpScope,
  driveOutsideMcpScope,
  driveDeniedByAppToken,
  filterDriveIdsByAppTokenScope,
  hasAgentUserScopedAccess,
} from '../actor-permissions';
import type { ToolExecutionContext } from '../../core/types';
import * as permissionsModule from '@pagespace/lib/permissions/permissions';

const DRIVE = 'drive-1';
const userCtx = { userId: 'user-1' } as ToolExecutionContext;
const agentCtx = {
  userId: 'user-1',
  chatSource: { type: 'page', agentPageId: 'agent-1' },
} as ToolExecutionContext;

// The single row the actor gate reads for `chatSource.agentPageId`: a REAL
// agent page (AI_CHAT) that has not opted into user-scoped reach. Only such a
// page authorizes as an agent; anything else falls through to the user.
const AGENT_PAGE_ROW = { type: 'AI_CHAT', userScopedAccess: false };

describe('canActorManageDrive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Agent actors look up their pages row for type/userScopedAccess.
    mockDbWhere.mockResolvedValue([AGENT_PAGE_ROW]);
  });

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
  beforeEach(() => {
    vi.clearAllMocks();
    // Agent actors look up their pages row for type/userScopedAccess.
    mockDbWhere.mockResolvedValue([AGENT_PAGE_ROW]);
  });

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
    mockDbWhere.mockResolvedValue([{ ...AGENT_PAGE_ROW, driveId: 'drive-B' }]);
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
    // One mock serves both selects: the actor row resolves the agent, and the
    // page-drive lookup finds no driveId (a drive id has no page row), so the
    // scope check falls back to treating the id itself as the drive.
    mockDbWhere.mockResolvedValue([AGENT_PAGE_ROW]);
    mockGetAgentAccessLevel.mockResolvedValue({ canEdit: true });
    expect(await canActorEditPage(scopedAgentCtx, 'drive-A')).toBe(true);
    // The scope ceiling passed (drive-A is in scope), so the agent ACL was consulted.
    expect(mockGetAgentAccessLevel).toHaveBeenCalledWith('agent-1', 'drive-A');
  });

  it('canActorEditPage: allows an in-scope page (then defers to the agent ACL)', async () => {
    mockDbWhere.mockResolvedValue([{ ...AGENT_PAGE_ROW, driveId: 'drive-A' }]);
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

describe('app-member RBAC ceiling (mcp_ key ceiling set)', () => {
  beforeEach(() => vi.clearAllMocks());

  const VIEW_ONLY = { canView: true, canEdit: false, canShare: false, canDelete: false };
  const FULL = { canView: true, canEdit: true, canShare: true, canDelete: true };

  // Scoped token driving an agent whose own ACL would allow everything.
  const tokenAgentCtx = {
    userId: 'user-1',
    chatSource: { type: 'page', agentPageId: 'agent-1' },
    mcpAllowedDriveIds: ['drive-A'],
    credentialCeiling: { kind: 'mcp', tokenId: 'token-1' },
  } as ToolExecutionContext;

  // Scoped token acting directly as the user (global assistant via MCP).
  const tokenUserCtx = {
    userId: 'user-1',
    mcpAllowedDriveIds: ['drive-A'],
    credentialCeiling: { kind: 'mcp', tokenId: 'token-1' },
  } as ToolExecutionContext;

  it('canActorEditPage: explicit MEMBER token (view-only page) is denied even when the agent ACL allows edit', async () => {
    mockDbWhere.mockResolvedValue([{ ...AGENT_PAGE_ROW, driveId: 'drive-A' }]);
    mockGetAppDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: null, ownerUserId: 'user-1' });
    mockGetAppAccessLevel.mockResolvedValue(VIEW_ONLY);
    mockGetAgentAccessLevel.mockResolvedValue(FULL);

    expect(await canActorEditPage(tokenAgentCtx, 'page-x')).toBe(false);
    expect(mockGetAppAccessLevel).toHaveBeenCalledWith('token-1', 'page-x');
    // Denied at the token ceiling — agent ACL never consulted.
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorEditPage: INHERITED token (role null) applies no ceiling — agent ACL decides', async () => {
    mockDbWhere.mockResolvedValue([{ ...AGENT_PAGE_ROW, driveId: 'drive-A' }]);
    mockGetAppDriveMembership.mockResolvedValue({ role: null, customRoleId: null, ownerUserId: 'user-1' });
    mockGetAgentAccessLevel.mockResolvedValue(FULL);

    expect(await canActorEditPage(tokenAgentCtx, 'page-x')).toBe(true);
    // No ceiling lookup for inherited rows.
    expect(mockGetAppAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorEditPage: explicit ADMIN token falls through to the agent ACL (deny-only, never grants)', async () => {
    mockDbWhere.mockResolvedValue([{ ...AGENT_PAGE_ROW, driveId: 'drive-A' }]);
    mockGetAppDriveMembership.mockResolvedValue({ role: 'ADMIN', customRoleId: null, ownerUserId: 'user-1' });
    mockGetAppAccessLevel.mockResolvedValue(FULL);
    mockGetAgentAccessLevel.mockResolvedValue({ ...FULL, canEdit: false });

    // Token allows edit but the agent's own ACL does not — still denied.
    expect(await canActorEditPage(tokenAgentCtx, 'page-x')).toBe(false);
    expect(mockGetAgentAccessLevel).toHaveBeenCalledWith('agent-1', 'page-x');
  });

  it('canActorViewPage: explicit-role token outside its page access (null level) is denied', async () => {
    mockDbWhere.mockResolvedValue([{ ...AGENT_PAGE_ROW, driveId: 'drive-A' }]);
    mockGetAppDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: null, ownerUserId: 'user-1' });
    mockGetAppAccessLevel.mockResolvedValue(null);

    expect(await canActorViewPage(tokenUserCtx, 'page-x')).toBe(false);
  });

  it('contexts without a credential ceiling keep the scope-only behavior (no app-permission lookups)', async () => {
    const legacyScopedCtx = {
      userId: 'user-1',
      chatSource: { type: 'page', agentPageId: 'agent-1' },
      mcpAllowedDriveIds: ['drive-A'],
    } as ToolExecutionContext;
    mockDbWhere.mockResolvedValue([{ ...AGENT_PAGE_ROW, driveId: 'drive-A' }]);
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
      credentialCeiling: { kind: 'mcp', tokenId: 'token-1' },
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

describe('app-member RBAC ceiling (OAuth grant ceiling set) — the same caps, resolved through the grant\'s rows', () => {
  beforeEach(() => vi.clearAllMocks());

  const VIEW_ONLY = { canView: true, canEdit: false, canShare: false, canDelete: false };
  const FULL = { canView: true, canEdit: true, canShare: true, canDelete: true };
  const ROWS = [{ driveId: 'drive-A', role: 'MEMBER' as const, customRoleId: null }];

  const grantAgentCtx = {
    userId: 'user-1',
    chatSource: { type: 'page', agentPageId: 'agent-1' },
    mcpAllowedDriveIds: ['drive-A'],
    credentialCeiling: { kind: 'oauth', driveScopes: ROWS },
  } as ToolExecutionContext;
  const grantUserCtx = {
    userId: 'user-1',
    mcpAllowedDriveIds: ['drive-A'],
    credentialCeiling: { kind: 'oauth', driveScopes: ROWS },
  } as ToolExecutionContext;

  it('canActorEditPage: an explicit MEMBER grant is denied edit even when the agent ACL allows it, resolved by getScopedAccessLevel for the grant\'s user', async () => {
    mockDbWhere.mockResolvedValue([{ ...AGENT_PAGE_ROW, driveId: 'drive-A' }]);
    mockGetScopedDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: null });
    mockGetScopedAccessLevel.mockResolvedValue(VIEW_ONLY);
    mockGetAgentAccessLevel.mockResolvedValue(FULL);

    expect(await canActorEditPage(grantAgentCtx, 'page-x')).toBe(false);
    expect(mockGetScopedAccessLevel).toHaveBeenCalledWith(ROWS, 'user-1', 'page-x');
    expect(mockGetAppAccessLevel).not.toHaveBeenCalled();
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorManageDrive: a MEMBER grant is denied manage even when its user owns the drive', async () => {
    mockGetScopedDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: null });
    mockCheckDriveAccess.mockResolvedValue({ isOwner: true, isAdmin: true, isMember: true });

    expect(await canActorManageDrive(grantUserCtx, 'drive-A')).toBe(false);
    expect(mockCheckDriveAccess).not.toHaveBeenCalled();
  });

  it('canActorAccessDrive: a grant whose row no longer grants is denied though the user has access', async () => {
    mockHasScopedDriveMembership.mockResolvedValue(false);
    mockGetUserDriveAccess.mockResolvedValue(true);

    expect(await canActorAccessDrive(grantUserCtx, 'drive-A')).toBe(false);
    expect(mockHasScopedDriveMembership).toHaveBeenCalledWith(ROWS, 'user-1', 'drive-A');
  });

  it('getActorAccessiblePagesInDrive: intersects with the grant\'s accessible set', async () => {
    mockGetScopedDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: null });
    const { getUserAccessiblePagesInDriveWithDetails } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(getUserAccessiblePagesInDriveWithDetails).mockResolvedValue([
      { id: 'p1', title: 'A', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false, permissions: { ...FULL } },
      { id: 'p2', title: 'B', type: 'DOCUMENT', parentId: null, position: 1, isTrashed: false, permissions: { ...FULL } },
    ]);
    mockGetScopedAccessiblePagesInDrive.mockResolvedValue([
      { id: 'p1', title: 'A', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false, permissions: { ...VIEW_ONLY } },
    ]);

    const result = await getActorAccessiblePagesInDrive(grantUserCtx, 'drive-A');
    expect(result.map((p) => [p.id, p.permissions])).toEqual([['p1', VIEW_ONLY]]);
  });

  it('driveDeniedByAppToken: manage is denied for a MEMBER grant, allowed for an ADMIN grant', async () => {
    mockGetScopedDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: null });
    expect(await driveDeniedByAppToken(grantUserCtx, 'drive-A', 'manage')).toBe(true);
    mockGetScopedDriveMembership.mockResolvedValue({ role: 'ADMIN', customRoleId: null });
    expect(await driveDeniedByAppToken(grantUserCtx, 'drive-A', 'manage')).toBe(false);
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

describe('user-scoped agents (userScopedAccess fallback to the invoking user)', () => {
  const FULL = { canView: true, canEdit: true, canShare: true, canDelete: true };

  beforeEach(() => {
    vi.clearAllMocks();
    // The agent's pages-row lookup: user-scoped access enabled.
    mockDbWhere.mockResolvedValue([{ type: 'AI_CHAT', userScopedAccess: true }]);
  });

  it('canActorViewPage authorizes as the invoking user, not the agent', async () => {
    const { getUserAccessLevel } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(getUserAccessLevel).mockResolvedValue(FULL);

    expect(await canActorViewPage(agentCtx, 'page-x')).toBe(true);
    expect(vi.mocked(getUserAccessLevel)).toHaveBeenCalledWith('user-1', 'page-x');
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorEditPage authorizes as the invoking user', async () => {
    const { canUserEditPage } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(canUserEditPage).mockResolvedValue(true);

    expect(await canActorEditPage(agentCtx, 'page-x')).toBe(true);
    expect(vi.mocked(canUserEditPage)).toHaveBeenCalledWith('user-1', 'page-x');
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorAccessDrive falls back to the user drive access, not agent membership', async () => {
    mockGetUserDriveAccess.mockResolvedValue(true);

    expect(await canActorAccessDrive(agentCtx, DRIVE)).toBe(true);
    expect(mockGetUserDriveAccess).toHaveBeenCalledWith('user-1', DRIVE);
    expect(mockHasAgentDriveMembership).not.toHaveBeenCalled();
  });

  it('canActorManageDrive requires the INVOKING user to be owner/admin (invoker-scoped)', async () => {
    mockCheckDriveAccess.mockResolvedValue({ isOwner: false, isAdmin: false, isMember: true });

    expect(await canActorManageDrive(agentCtx, DRIVE)).toBe(false);
    expect(mockHasAgentDriveMembership).not.toHaveBeenCalled();
  });

  it('getActorAccessiblePagesInDrive returns the user page set', async () => {
    const { getUserAccessiblePagesInDriveWithDetails } = await import('@pagespace/lib/permissions/permissions');
    const { getAgentAccessiblePagesInDrive } = await import('@pagespace/lib/permissions/agent-permissions');
    vi.mocked(getUserAccessiblePagesInDriveWithDetails).mockResolvedValue([
      { id: 'p1', title: 'A', type: 'DOCUMENT', parentId: null, position: 0, isTrashed: false, permissions: { ...FULL } },
    ]);

    const result = await getActorAccessiblePagesInDrive(agentCtx, DRIVE);
    expect(result.map((p) => p.id)).toEqual(['p1']);
    expect(vi.mocked(getAgentAccessiblePagesInDrive)).not.toHaveBeenCalled();
  });

  it('keeps the agent-scoped path when the flag is off', async () => {
    mockDbWhere.mockResolvedValue([AGENT_PAGE_ROW]);
    mockGetAgentAccessLevel.mockResolvedValue(FULL);

    expect(await canActorViewPage(agentCtx, 'page-x')).toBe(true);
    expect(mockGetAgentAccessLevel).toHaveBeenCalledWith('agent-1', 'page-x');
  });

  it('a scoped MCP token still ceilings a user-scoped agent', async () => {
    const scopedCtx = {
      userId: 'user-1',
      chatSource: { type: 'page', agentPageId: 'agent-1' },
      mcpAllowedDriveIds: ['drive-A'],
    } as ToolExecutionContext;

    expect(await canActorAccessDrive(scopedCtx, 'drive-B')).toBe(false);
    expect(mockGetUserDriveAccess).not.toHaveBeenCalled();
  });
});

// Field bug (pagespace.ai prod): a non-agent-page conversation carries that
// page as `chatSource.agentPageId` (chat/route.ts sets it for EVERY page
// chat), so the acting-agent gate used to authorize as a page that is not an
// agent at all — no driveAgentMembers row exists, so every canActor* check
// denied. The honest actor is the user the chat route already authorized.
describe('non-agent-page conversations (agentPageId is not an AI_CHAT agent)', () => {
  const FULL = { canView: true, canEdit: true, canShare: true, canDelete: true };
  const nonAgentPaneCtx = {
    userId: 'user-1',
    chatSource: { type: 'page', agentPageId: 'doc-1' },
  } as ToolExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWhere.mockResolvedValue([{ type: 'DOCUMENT', userScopedAccess: false }]);
  });

  it('canActorViewPage authorizes as the invoking user (the prod repro: tools denied by the phantom-agent gate)', async () => {
    const { getUserAccessLevel } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(getUserAccessLevel).mockResolvedValue(FULL);

    expect(await canActorViewPage(nonAgentPaneCtx, 'doc-1')).toBe(true);
    expect(vi.mocked(getUserAccessLevel)).toHaveBeenCalledWith('user-1', 'doc-1');
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorViewPage still denies when the USER has no access to the page', async () => {
    const { getUserAccessLevel } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(getUserAccessLevel).mockResolvedValue(null);

    expect(await canActorViewPage(nonAgentPaneCtx, 'doc-1')).toBe(false);
  });

  it('canActorEditPage / canActorAccessDrive authorize as the user too (page & drive tools, silently broken before)', async () => {
    const { canUserEditPage } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(canUserEditPage).mockResolvedValue(true);
    mockGetUserDriveAccess.mockResolvedValue(true);

    expect(await canActorEditPage(nonAgentPaneCtx, 'page-x')).toBe(true);
    expect(vi.mocked(canUserEditPage)).toHaveBeenCalledWith('user-1', 'page-x');
    expect(await canActorAccessDrive(nonAgentPaneCtx, DRIVE)).toBe(true);
    expect(mockGetUserDriveAccess).toHaveBeenCalledWith('user-1', DRIVE);
    expect(mockHasAgentDriveMembership).not.toHaveBeenCalled();
  });

  it('reads the acting-page row exactly once per check (the type gate adds no query)', async () => {
    const { getUserAccessLevel } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(getUserAccessLevel).mockResolvedValue(FULL);

    await canActorViewPage(nonAgentPaneCtx, 'doc-1');
    expect(mockDbWhere).toHaveBeenCalledTimes(1);
  });

  it('a MISSING page row also falls through to the user — a page that does not exist is not an agent', async () => {
    mockDbWhere.mockResolvedValue([]);
    const { getUserAccessLevel } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(getUserAccessLevel).mockResolvedValue(FULL);

    expect(await canActorViewPage(nonAgentPaneCtx, 'page-x')).toBe(true);
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('ANY non-agent page type falls through to the user — never to a phantom agent, never beyond the user', async () => {
    // A chat on a FOLDER (or any other non-agent page type) carries that page
    // as agentPageId too. Before the type gate it acted as a phantom agent
    // that denied everything; now it acts as the INVOKING USER — an
    // authority that user already has in any Global Assistant conversation,
    // so the fall-through grants nothing beyond their own reach.
    mockDbWhere.mockResolvedValue([{ type: 'FOLDER', userScopedAccess: false }]);
    const { getUserAccessLevel } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(getUserAccessLevel).mockResolvedValue(FULL);

    expect(await canActorViewPage(nonAgentPaneCtx, 'page-x')).toBe(true);
    expect(vi.mocked(getUserAccessLevel)).toHaveBeenCalledWith('user-1', 'page-x');
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  // A consulted agent (ask_agent) inherits the PARENT's actor identity — the
  // nested context spreads the caller's chatSource — so from a non-agent pane
  // it resolves to the invoking user and can never exceed that user's own ACL.
  it('a nested ask_agent run from a non-agent pane stays bounded by the invoking user', async () => {
    const { getUserAccessLevel } = await import('@pagespace/lib/permissions/permissions');
    vi.mocked(getUserAccessLevel).mockResolvedValue(null);
    const nestedCtx = {
      ...nonAgentPaneCtx,
      agentCallDepth: 1,
      parentAgentId: 'doc-1',
      requestOrigin: 'agent',
    } as ToolExecutionContext;

    expect(await canActorViewPage(nestedCtx, 'page-the-user-cannot-see')).toBe(false);
    expect(vi.mocked(getUserAccessLevel)).toHaveBeenCalledWith('user-1', 'page-the-user-cannot-see');
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('an AI_CHAT page keeps the agent-scoped path (the gate only rejects non-agent pages)', async () => {
    mockDbWhere.mockResolvedValue([AGENT_PAGE_ROW]);
    mockGetAgentAccessLevel.mockResolvedValue(FULL);

    expect(await canActorViewPage(agentCtx, 'page-x')).toBe(true);
    expect(mockGetAgentAccessLevel).toHaveBeenCalledWith('agent-1', 'page-x');
  });
});

// The Agent Memory write path: every AI_CHAT agent is instructed (agent-memory.ts)
// to create and edit an "Agent Memory" child of its own page, but the default
// MEMBER membership resolves canEdit:false on every non-channel page — so the
// write was refused everywhere, and cron workflow runs (whose tool context
// carries the agent identity) failed with "Insufficient permissions to edit
// this document". The agent's own subtree is the one space it authors.
describe('agent-owned subtree (Agent Memory write path)', () => {
  const VIEW_ONLY = { canView: true, canEdit: false, canShare: false, canDelete: false };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWhere.mockResolvedValue([AGENT_PAGE_ROW]);
  });

  it('canActorEditPage: the agent page itself is editable (create_page passes it as the parent)', async () => {
    expect(await canActorEditPage(agentCtx, 'agent-1')).toBe(true);
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorEditPage: a child of the agent page ("Agent Memory") is editable despite a view-only membership', async () => {
    mockGetAgentAccessLevel.mockResolvedValue(VIEW_ONLY);
    mockDbWhere.mockResolvedValueOnce([AGENT_PAGE_ROW]).mockResolvedValueOnce([{ parentId: 'agent-1' }]);

    expect(await canActorEditPage(agentCtx, 'memory-page')).toBe(true);
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorEditPage: a grandchild is editable too (the walk follows the parent chain)', async () => {
    mockGetAgentAccessLevel.mockResolvedValue(VIEW_ONLY);
    mockDbWhere
      .mockResolvedValueOnce([AGENT_PAGE_ROW])
      .mockResolvedValueOnce([{ parentId: 'memory-page' }])
      .mockResolvedValueOnce([{ parentId: 'agent-1' }]);

    expect(await canActorEditPage(agentCtx, 'deep-note')).toBe(true);
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorEditPage: an unrelated page still defers to the membership ACL', async () => {
    mockGetAgentAccessLevel.mockResolvedValue(VIEW_ONLY);
    mockDbWhere.mockResolvedValueOnce([AGENT_PAGE_ROW]).mockResolvedValueOnce([{ parentId: null }]);

    expect(await canActorEditPage(agentCtx, 'some-doc')).toBe(false);
    expect(mockGetAgentAccessLevel).toHaveBeenCalledWith('agent-1', 'some-doc');
  });

  it('canActorEditPage: an MCP token scope still ceilings the own subtree', async () => {
    const scopedAgentCtx = {
      userId: 'user-1',
      chatSource: { type: 'page', agentPageId: 'agent-1' },
      mcpAllowedDriveIds: ['drive-A'],
    } as ToolExecutionContext;
    mockDbWhere
      .mockResolvedValueOnce([{ driveId: 'drive-B' }]) // pageOutsideMcpScope: memory-page's drive
      .mockResolvedValueOnce([AGENT_PAGE_ROW]);

    expect(await canActorEditPage(scopedAgentCtx, 'memory-page')).toBe(false);
    expect(mockGetAgentAccessLevel).not.toHaveBeenCalled();
  });

  it('canActorEditPage: an explicit-role credential ceiling still denies inside the own subtree', async () => {
    const ceiledAgentCtx = {
      userId: 'user-1',
      chatSource: { type: 'page', agentPageId: 'agent-1' },
      mcpAllowedDriveIds: ['drive-A'],
      credentialCeiling: { kind: 'mcp', tokenId: 'token-1' },
    } as ToolExecutionContext;
    // Every row read is in scope AND a child of the agent page, so the walk
    // would grant edit if it ran before the ceiling. (mockReset drains any
    // once-queue an earlier test left behind.)
    mockDbWhere.mockReset().mockResolvedValue([{ ...AGENT_PAGE_ROW, driveId: 'drive-A', parentId: 'agent-1' }]);
    mockGetAppDriveMembership.mockResolvedValue({ role: 'MEMBER', customRoleId: null, ownerUserId: 'user-1' });
    mockGetAppAccessLevel.mockResolvedValue(VIEW_ONLY);

    expect(await canActorEditPage(ceiledAgentCtx, 'memory-page')).toBe(false);
    expect(mockGetAppAccessLevel).toHaveBeenCalledWith('token-1', 'memory-page');
  });

  it('canActorDeletePage is NOT widened by the walk — the agent cannot trash its own page', async () => {
    // canEdit:true is exactly what the walk would grant on the agent's own
    // page; delete must still come from the membership ACL alone.
    mockGetAgentAccessLevel.mockResolvedValue({ canView: true, canEdit: true, canShare: true, canDelete: false });

    expect(await canActorDeletePage(agentCtx, 'agent-1')).toBe(false);
    expect(mockGetAgentAccessLevel).toHaveBeenCalledWith('agent-1', 'agent-1');
  });
});

describe('hasAgentUserScopedAccess', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when the agent page has userScopedAccess set', async () => {
    mockDbWhere.mockResolvedValue([{ type: 'AI_CHAT', userScopedAccess: true }]);
    expect(await hasAgentUserScopedAccess('agent-1')).toBe(true);
  });

  it('returns false when the agent page has userScopedAccess unset', async () => {
    mockDbWhere.mockResolvedValue([{ userScopedAccess: false }]);
    expect(await hasAgentUserScopedAccess('agent-1')).toBe(false);
  });

  it('defaults to false when the agent page is not found', async () => {
    mockDbWhere.mockResolvedValue([]);
    expect(await hasAgentUserScopedAccess('missing-agent')).toBe(false);
  });

  it('a non-agent page is never user-scoped, even with the column set — lockstep with resolveActingAgentId', async () => {
    // The two seams answer the same question ("is this an agent acting with
    // the user's reach?") — a non-AI_CHAT page row that somehow carries
    // userScopedAccess: true must not diverge the answers.
    mockDbWhere.mockResolvedValue([{ type: 'DOCUMENT', userScopedAccess: true }]);
    expect(await hasAgentUserScopedAccess('doc-page')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canActorConsultAgent — the ONE rule for "may this actor ask that agent",
// shared by executeAskAgent and the channel-mention responder. Viewing the
// agent page is sufficient; membership of the agent in the drive the actor is
// operating in, plus the actor's own access to that drive, is the other grant
// (guest agents: added to a drive from elsewhere so its members can talk to it).
// ---------------------------------------------------------------------------
describe('canActorConsultAgent', () => {
  const AGENT = 'agent-guest';
  const getUserAccessLevel = vi.mocked(permissionsModule.getUserAccessLevel);

  beforeEach(() => {
    vi.clearAllMocks();
    mockDbWhere.mockResolvedValue([]); // no chatSource row lookups needed for a user ctx
  });

  it('allows when the actor can view the agent page (membership never consulted)', async () => {
    getUserAccessLevel.mockResolvedValue({ canView: true, canEdit: false, canShare: false, canDelete: false });
    expect(await canActorConsultAgent(userCtx, AGENT, DRIVE)).toBe(true);
    expect(mockHasAgentDriveMembership).not.toHaveBeenCalled();
  });

  it('allows a guest agent that is a member of the current drive when the actor can access that drive', async () => {
    getUserAccessLevel.mockResolvedValue(null);
    mockHasAgentDriveMembership.mockResolvedValue(true);
    mockGetUserDriveAccess.mockResolvedValue(true);
    expect(await canActorConsultAgent(userCtx, AGENT, DRIVE)).toBe(true);
    expect(mockHasAgentDriveMembership).toHaveBeenCalledWith(AGENT, DRIVE);
    expect(mockGetUserDriveAccess).toHaveBeenCalledWith('user-1', DRIVE);
  });

  it('denies a guest agent member when the actor cannot access the current drive', async () => {
    getUserAccessLevel.mockResolvedValue(null);
    mockHasAgentDriveMembership.mockResolvedValue(true);
    mockGetUserDriveAccess.mockResolvedValue(false);
    expect(await canActorConsultAgent(userCtx, AGENT, DRIVE)).toBe(false);
  });

  it('denies when the agent is not a member of the current drive', async () => {
    getUserAccessLevel.mockResolvedValue(null);
    mockHasAgentDriveMembership.mockResolvedValue(false);
    mockGetUserDriveAccess.mockResolvedValue(true);
    expect(await canActorConsultAgent(userCtx, AGENT, DRIVE)).toBe(false);
  });

  it('falls back to locationContext.currentDrive when no drive id is passed, and denies with neither', async () => {
    getUserAccessLevel.mockResolvedValue(null);
    mockHasAgentDriveMembership.mockResolvedValue(true);
    mockGetUserDriveAccess.mockResolvedValue(true);
    const located = { ...userCtx, locationContext: { currentDrive: { id: DRIVE, name: 'D', slug: 'd' } } } as ToolExecutionContext;
    expect(await canActorConsultAgent(located, AGENT)).toBe(true);
    expect(mockHasAgentDriveMembership).toHaveBeenCalledWith(AGENT, DRIVE);
    expect(await canActorConsultAgent(userCtx, AGENT)).toBe(false);
  });

  it('denies a drive outside the MCP token scope even for a member agent', async () => {
    getUserAccessLevel.mockResolvedValue(null);
    mockHasAgentDriveMembership.mockResolvedValue(true);
    mockGetUserDriveAccess.mockResolvedValue(true);
    const scoped = { ...userCtx, mcpAllowedDriveIds: ['drive-other'] } as ToolExecutionContext;
    expect(await canActorConsultAgent(scoped, AGENT, DRIVE)).toBe(false);
  });
});


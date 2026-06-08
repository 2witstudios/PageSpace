import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockHasAgentDriveMembership,
  mockCheckDriveAccess,
  mockGetUserDriveAccess,
  mockGetAgentAccessLevel,
  mockDbWhere,
} = vi.hoisted(() => ({
  mockHasAgentDriveMembership: vi.fn(),
  mockCheckDriveAccess: vi.fn(),
  mockGetUserDriveAccess: vi.fn(),
  mockGetAgentAccessLevel: vi.fn(),
  mockDbWhere: vi.fn(),
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
  filterDriveIdsByMcpScope,
  driveOutsideMcpScope,
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

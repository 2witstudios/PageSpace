import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHasAgentDriveMembership, mockCheckDriveAccess } = vi.hoisted(() => ({
  mockHasAgentDriveMembership: vi.fn(),
  mockCheckDriveAccess: vi.fn(),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getUserAccessLevel: vi.fn(),
  getUserDriveAccess: vi.fn(),
  canUserEditPage: vi.fn(),
  canUserDeletePage: vi.fn(),
  getUserAccessiblePagesInDriveWithDetails: vi.fn(),
}));
vi.mock('@pagespace/lib/permissions/agent-permissions', () => ({
  getAgentAccessLevel: vi.fn(),
  getAgentAccessiblePagesInDrive: vi.fn(),
  hasAgentDriveMembership: mockHasAgentDriveMembership,
}));
vi.mock('@pagespace/lib/services/drive-member-service', () => ({
  checkDriveAccess: mockCheckDriveAccess,
}));

import { canActorManageDrive } from '../actor-permissions';
import type { ToolExecutionContext } from '../../core';

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

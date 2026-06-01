import { describe, it, expect } from 'vitest';
import { canRunCode, type CanRunCodeDeps } from '../can-run-code';
import type { DrivePermissionLevel } from '../../../permissions/permissions';
import type { PermissionLevel } from '../../../permissions/permissions';

const ownerPerms: DrivePermissionLevel = {
  hasAccess: true,
  isOwner: true,
  isAdmin: false,
  isMember: false,
  canEdit: true,
};

const adminPerms: DrivePermissionLevel = {
  hasAccess: true,
  isOwner: false,
  isAdmin: true,
  isMember: true,
  canEdit: true,
};

const memberPerms: DrivePermissionLevel = {
  hasAccess: true,
  isOwner: false,
  isAdmin: false,
  isMember: true,
  canEdit: true,
};

const agentEditPerms: PermissionLevel = {
  canView: true,
  canEdit: true,
  canShare: false,
  canDelete: false,
};

const agentViewOnlyPerms: PermissionLevel = {
  canView: true,
  canEdit: false,
  canShare: false,
  canDelete: false,
};

// Fully-permissive deps; individual tests override the single field under test
// so each test exercises exactly one denial path.
function makeDeps(overrides: Partial<CanRunCodeDeps> = {}): CanRunCodeDeps {
  return {
    getUserDrivePermissions: async () => adminPerms,
    getAgentAccessLevel: async () => agentEditPerms,
    isCloud: () => true,
    isCodeExecutionEnabled: () => true,
    ...overrides,
  };
}

describe('canRunCode', () => {
  it('given an admin drive member in cloud with the kill-switch on, should allow', async () => {
    const result = await canRunCode({ userId: 'u1', driveId: 'd1', deps: makeDeps() });
    expect(result.ok).toBe(true);
  });

  it('given a drive owner, should allow', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      deps: makeDeps({ getUserDrivePermissions: async () => ownerPerms }),
    });
    expect(result.ok).toBe(true);
  });

  it('given the kill-switch off, should deny regardless of authorization', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      deps: makeDeps({ isCodeExecutionEnabled: () => false }),
    });
    expect(result).toEqual({ ok: false, reason: 'kill_switch_off' });
  });

  it('given a non-cloud deployment, should deny', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      deps: makeDeps({ isCloud: () => false }),
    });
    expect(result).toEqual({ ok: false, reason: 'not_cloud' });
  });

  it('given a user with no drive membership, should deny', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      deps: makeDeps({ getUserDrivePermissions: async () => null }),
    });
    expect(result).toEqual({ ok: false, reason: 'no_drive_access' });
  });

  it('given a plain member without admin/owner role, should deny', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      deps: makeDeps({ getUserDrivePermissions: async () => memberPerms }),
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_role' });
  });

  it('given an agent actor with edit access, should allow', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      requestOrigin: 'agent',
      agentPageId: 'agent1',
      deps: makeDeps(),
    });
    expect(result.ok).toBe(true);
  });

  it('given an agent actor without a page id, should deny', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      requestOrigin: 'agent',
      deps: makeDeps(),
    });
    expect(result).toEqual({ ok: false, reason: 'no_agent_access' });
  });

  it('given an agent actor with view-only access, should deny', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      requestOrigin: 'agent',
      agentPageId: 'agent1',
      deps: makeDeps({ getAgentAccessLevel: async () => agentViewOnlyPerms }),
    });
    expect(result).toEqual({ ok: false, reason: 'no_agent_access' });
  });

  it('given a permission lookup that throws, should fail closed without throwing', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      deps: makeDeps({
        getUserDrivePermissions: async () => {
          throw new Error('db down');
        },
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'error' });
  });
});

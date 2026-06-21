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
    getUserRole: async () => 'admin',
    getAgentAccessLevel: async () => agentEditPerms,
    isCodeExecutionEnabled: () => true,
    getNodeEnv: () => 'test',
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

  it('given production and a non-admin app user, should deny even with drive admin access', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      deps: makeDeps({
        getUserRole: async () => 'user',
        getNodeEnv: () => 'production',
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'app_admin_required' });
  });

  it('given production and an admin app user, should allow when drive authorization passes', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      deps: makeDeps({
        getUserRole: async () => 'admin',
        getNodeEnv: () => 'production',
      }),
    });
    expect(result.ok).toBe(true);
  });

  it('given development and a non-admin app user, should preserve the drive-role gate', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      deps: makeDeps({
        getUserRole: async () => 'user',
        getNodeEnv: () => 'development',
      }),
    });
    expect(result.ok).toBe(true);
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

  it('given an agent actor whose triggering user is only a plain member, should deny on the user gate', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      requestOrigin: 'agent',
      agentPageId: 'agent1',
      deps: makeDeps({ getUserDrivePermissions: async () => memberPerms }),
    });
    expect(result).toEqual({ ok: false, reason: 'insufficient_role' });
  });

  it('given an agent actor whose triggering user has no drive membership, should deny on the user gate', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      requestOrigin: 'agent',
      agentPageId: 'agent1',
      deps: makeDeps({ getUserDrivePermissions: async () => null }),
    });
    expect(result).toEqual({ ok: false, reason: 'no_drive_access' });
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

  it('given no driveId and kill switch off, should deny with kill_switch_off', async () => {
    const result = await canRunCode({
      userId: 'u1',
      deps: makeDeps({ isCodeExecutionEnabled: () => false }),
    });
    expect(result).toEqual({ ok: false, reason: 'kill_switch_off' });
  });

  it('given no driveId, production env, and admin user, should allow', async () => {
    const result = await canRunCode({
      userId: 'u1',
      deps: makeDeps({ getNodeEnv: () => 'production', getUserRole: async () => 'admin' }),
    });
    expect(result.ok).toBe(true);
  });

  it('given no driveId, production env, and non-admin user, should deny with app_admin_required', async () => {
    const result = await canRunCode({
      userId: 'u1',
      deps: makeDeps({ getNodeEnv: () => 'production', getUserRole: async () => 'user' }),
    });
    expect(result).toEqual({ ok: false, reason: 'app_admin_required' });
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

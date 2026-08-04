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
// so each test exercises exactly one denial path. Tier defaults to 'pro' (so
// the tier gate stays out of the way of tests exercising other gates), and
// `lookupDriveOwnerId` defaults to null (payer falls back to the resolved
// `ownerId`/`userId`), matching what most tests actually want to exercise.
function makeDeps(overrides: Partial<CanRunCodeDeps> = {}): CanRunCodeDeps {
  return {
    getUserDrivePermissions: async () => adminPerms,
    lookupDriveOwnerId: async () => null,
    getUserSubscriptionTier: async () => 'pro',
    getAgentAccessLevel: async () => agentEditPerms,
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

  it('given a free-tier payer, should deny with tier_ineligible', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      deps: makeDeps({ getUserSubscriptionTier: async () => 'free' }),
    });
    expect(result).toEqual({ ok: false, reason: 'tier_ineligible' });
  });

  it('given a pro-tier payer, should allow', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      deps: makeDeps({ getUserSubscriptionTier: async () => 'pro' }),
    });
    expect(result.ok).toBe(true);
  });

  it('given a free-tier ACTOR inside a drive owned by a pro-tier user, should allow — the PAYER (drive owner), not the actor, is checked', async () => {
    const result = await canRunCode({
      userId: 'free-actor',
      driveId: 'd1',
      deps: makeDeps({
        lookupDriveOwnerId: async () => 'pro-owner',
        getUserSubscriptionTier: async (userId) => (userId === 'pro-owner' ? 'pro' : 'free'),
      }),
    });
    expect(result.ok).toBe(true);
  });

  it('given a pro-tier ACTOR inside a drive owned by a free-tier user, should deny — the payer, not the actor, is checked', async () => {
    const result = await canRunCode({
      userId: 'pro-actor',
      driveId: 'd1',
      deps: makeDeps({
        lookupDriveOwnerId: async () => 'free-owner',
        getUserSubscriptionTier: async (userId) => (userId === 'free-owner' ? 'free' : 'pro'),
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'tier_ineligible' });
  });

  it('given no driveId (global assistant) and a free-tier session owner, should deny with tier_ineligible', async () => {
    const result = await canRunCode({
      userId: 'u1',
      ownerId: 'u1',
      deps: makeDeps({ getUserSubscriptionTier: async () => 'free' }),
    });
    expect(result).toEqual({ ok: false, reason: 'tier_ineligible' });
  });

  it('given no driveId (global assistant) and a pro-tier session owner, should allow', async () => {
    const result = await canRunCode({
      userId: 'u1',
      ownerId: 'u1',
      deps: makeDeps({ getUserSubscriptionTier: async () => 'pro' }),
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

  it('given no driveId and agent requestOrigin, should deny — agent-origin always requires a drive context', async () => {
    const result = await canRunCode({
      userId: 'u1',
      requestOrigin: 'agent',
      agentPageId: 'agent1',
      deps: makeDeps(),
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

  it('given a tier lookup that throws, should fail closed without throwing', async () => {
    const result = await canRunCode({
      userId: 'u1',
      driveId: 'd1',
      deps: makeDeps({
        getUserSubscriptionTier: async () => {
          throw new Error('db down');
        },
      }),
    });
    expect(result).toEqual({ ok: false, reason: 'error' });
  });
});

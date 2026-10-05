/**
 * Imago agents' drive grants against a REAL Postgres — no fake DB, no vi.mock.
 *
 * DEC-2: a user's Imago agents are auto-granted membership in the STANDARD
 * drives the user owns — when the agents are provisioned and when the user
 * creates a drive — through `addAgentToDrive`, the one membership seam. Any
 * other drive (Home, a drive the user merely belongs to, a drive they were
 * handed by an ownership transfer) is reached only through an explicit grant.
 * These tests drive the real provisioning, drive-creation and transfer paths
 * and read the resulting `drive_agent_members` rows and the agent's resolved
 * permissions back from the database.
 *
 * Requires DATABASE_URL → a migrated Postgres. FAILS LOUDLY when none is
 * reachable; local runs without a database opt out with ALLOW_SKIP_DB_TESTS=1.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveAgentMembers } from '@pagespace/db/schema/members';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { BUILTIN_AGENT_KEYS } from '../builtin-agents';
import { provisionImagoAgents } from '../provision-imago-agents';
import { grantImagoAgentsToOwnedDrives, revokeImagoAgentGrants } from '../grant-imago-agents';
import { provisionHomeDriveIfNeeded } from '../../onboarding/home-drive';
import { createDrive, transferDriveOwnership } from '../../services/drive-service';
import { addAgentToDrive, removeAgentFromDrive } from '../../services/drive-agent-service';
import { getAgentAccessLevel, hasAgentDriveAdminRole } from '../../permissions/agent-permissions';

let dbAvailable = false;

beforeAll(async () => {
  try {
    await db.select().from(pages).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('grant-imago-agents.integration.test.ts', error);
    dbAvailable = false;
  }
});

async function userWithHome() {
  const user = await factories.createUser();
  const home = await factories.createDrive(user.id, { kind: 'HOME', name: 'Home', slug: 'home' });
  return { user, home };
}

async function provisionedAgentIds(userId: string): Promise<string[]> {
  const result = await provisionImagoAgents(userId);
  return Object.values(result.agents);
}

/** Every membership row of the given agents, keyed `${agentPageId}:${driveId}`. */
async function membershipsOf(agentIds: string[]) {
  const rows = await db
    .select()
    .from(driveAgentMembers)
    .where(inArray(driveAgentMembers.agentPageId, agentIds));
  return rows;
}

async function grantedDriveIds(agentIds: string[], driveId: string) {
  const rows = await db
    .select({ agentPageId: driveAgentMembers.agentPageId })
    .from(driveAgentMembers)
    .where(and(inArray(driveAgentMembers.agentPageId, agentIds), eq(driveAgentMembers.driveId, driveId)));
  return rows.map((row) => row.agentPageId).sort();
}

describe('Imago agent grants on provisioning (real Postgres)', () => {
  it('given a user with owned STANDARD drives, should grant every Imago agent MEMBER in each of them and in no other drive', async () => {
    if (!dbAvailable) return;
    const { user, home } = await userWithHome();
    const ownedA = await factories.createDrive(user.id, { name: 'Owned A' });
    const ownedB = await factories.createDrive(user.id, { name: 'Owned B' });
    // Negative controls: a drive the user is an ADMIN of but does not own, and
    // a stranger's drive the user cannot see at all.
    const other = await factories.createUser();
    const adminOf = await factories.createDrive(other.id, { name: 'Admin of' });
    await factories.createDriveMember(adminOf.id, user.id, { role: 'ADMIN' });
    const stranger = await factories.createDrive(other.id, { name: 'Stranger' });

    const result = await provisionHomeDriveIfNeeded(user.id);
    expect(result.driveId).toBe(home.id);

    const agentIds = (await provisionImagoAgents(user.id)).agents;
    const ids = Object.values(agentIds);
    expect(ids).toHaveLength(BUILTIN_AGENT_KEYS.length);

    const rows = await membershipsOf(ids);
    const byDrive = (driveId: string) => rows.filter((row) => row.driveId === driveId);
    for (const owned of [ownedA, ownedB]) {
      expect(byDrive(owned.id).map((row) => row.agentPageId).sort()).toEqual([...ids].sort());
      for (const row of byDrive(owned.id)) {
        expect(row).toMatchObject({ role: 'MEMBER', customRoleId: null, addedBy: user.id, includeContext: false });
      }
    }
    expect(byDrive(adminOf.id)).toEqual([]);
    expect(byDrive(stranger.id)).toEqual([]);
    // Home holds only the agents' native membership from provisioning.
    expect(byDrive(home.id)).toHaveLength(ids.length);
    expect(rows).toHaveLength(ids.length * 3);
  });

  it('given the standalone provisioner, should grant the agents it creates in the owned STANDARD drives', async () => {
    if (!dbAvailable) return;
    const { user } = await userWithHome();
    const owned = await factories.createDrive(user.id, { name: 'Owned' });

    const ids = await provisionedAgentIds(user.id);

    expect(await grantedDriveIds(ids, owned.id)).toEqual([...ids].sort());
  });

  it('given a trashed owned drive, should not grant the agents in it', async () => {
    if (!dbAvailable) return;
    const { user } = await userWithHome();
    const trashed = await factories.createDrive(user.id, { name: 'Trashed', isTrashed: true, trashedAt: new Date() });

    const ids = await provisionedAgentIds(user.id);

    expect(await grantedDriveIds(ids, trashed.id)).toEqual([]);
  });

  it('given re-provisioning, should add no rows and should not re-grant a drive whose grant the user removed', async () => {
    if (!dbAvailable) return;
    const { user } = await userWithHome();
    const owned = await factories.createDrive(user.id, { name: 'Owned' });
    const ids = await provisionedAgentIds(user.id);
    const before = await membershipsOf(ids);

    await provisionHomeDriveIfNeeded(user.id);
    await provisionImagoAgents(user.id);
    expect((await membershipsOf(ids)).map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());

    // The user turns Imago off for this drive (the IMG-4.6 toggle removes the membership).
    const removed = await removeAgentFromDrive({ actingUserId: user.id, agentPageId: ids[0], driveId: owned.id });
    expect(removed).toEqual({ ok: true });

    await provisionHomeDriveIfNeeded(user.id);
    await provisionImagoAgents(user.id);
    expect(await grantedDriveIds(ids, owned.id)).toEqual(ids.slice(1).sort());
  });

  it('given a deleted agent recreated on re-provision, should grant the new page in the owned STANDARD drives Imago is on', async () => {
    if (!dbAvailable) return;
    const { user } = await userWithHome();
    const owned = await factories.createDrive(user.id, { name: 'Owned' });
    const first = await provisionImagoAgents(user.id);
    await db.delete(pages).where(eq(pages.id, first.agents['imago-planner']));

    const second = await provisionImagoAgents(user.id);

    expect(await grantedDriveIds([second.agents['imago-planner']], owned.id)).toEqual([second.agents['imago-planner']]);
  });

  it('given a grant call repeated for the same drives, should report the existing grants and add nothing', async () => {
    if (!dbAvailable) return;
    const { user } = await userWithHome();
    const owned = await factories.createDrive(user.id, { name: 'Owned' });
    const ids = await provisionedAgentIds(user.id);

    const outcomes = await grantImagoAgentsToOwnedDrives(user.id, { driveIds: [owned.id] });

    expect(outcomes.map((outcome) => outcome.status)).toEqual(ids.map(() => 'already'));
    expect(await grantedDriveIds(ids, owned.id)).toEqual([...ids].sort());
  });

  it('given drive ids the user does not own, should grant nothing there', async () => {
    if (!dbAvailable) return;
    const { user, home } = await userWithHome();
    const ids = await provisionedAgentIds(user.id);
    const other = await factories.createUser();
    const adminOf = await factories.createDrive(other.id, { name: 'Admin of' });
    await factories.createDriveMember(adminOf.id, user.id, { role: 'ADMIN' });

    const outcomes = await grantImagoAgentsToOwnedDrives(user.id, { driveIds: [adminOf.id, home.id] });

    expect(outcomes).toEqual([]);
    expect(await grantedDriveIds(ids, adminOf.id)).toEqual([]);
  });
});

describe('Imago agent grants on drive creation (real Postgres)', () => {
  it('given a user with Imago agents, should grant them MEMBER in a STANDARD drive the user creates', async () => {
    if (!dbAvailable) return;
    const { user } = await userWithHome();
    const ids = await provisionedAgentIds(user.id);

    const created = await createDrive(user.id, { name: 'Fresh drive' });

    const rows = await db
      .select()
      .from(driveAgentMembers)
      .where(eq(driveAgentMembers.driveId, created.id));
    expect(rows.map((row) => row.agentPageId).sort()).toEqual([...ids].sort());
    for (const row of rows) expect(row).toMatchObject({ role: 'MEMBER', addedBy: user.id });
  });

  it('given another user creating a drive, should not grant this user\'s agents in it', async () => {
    if (!dbAvailable) return;
    const { user } = await userWithHome();
    const ids = await provisionedAgentIds(user.id);
    const { user: other } = await userWithHome();
    await provisionedAgentIds(other.id);

    const created = await createDrive(other.id, { name: 'Not yours' });

    expect(await grantedDriveIds(ids, created.id)).toEqual([]);
  });

  it('given a user without Imago agents, should create the drive with no agent grants', async () => {
    if (!dbAvailable) return;
    const user = await factories.createUser();

    const created = await createDrive(user.id, { name: 'No agents yet' });

    expect(await db.select().from(driveAgentMembers).where(eq(driveAgentMembers.driveId, created.id))).toEqual([]);
  });
});

describe('Imago agent reach is capped at the granted role (real Postgres)', () => {
  it('given a MEMBER grant, should resolve view-only access to shared pages and none to private pages or ungranted drives', async () => {
    if (!dbAvailable) return;
    const { user } = await userWithHome();
    const owned = await factories.createDrive(user.id, { name: 'Owned' });
    const doc = await factories.createPage(owned.id, { title: 'Doc', type: 'DOCUMENT' });
    const secret = await factories.createPage(owned.id, { title: 'Secret', type: 'DOCUMENT', isPrivate: true });
    const other = await factories.createUser();
    const adminOf = await factories.createDrive(other.id, { name: 'Admin of' });
    await factories.createDriveMember(adminOf.id, user.id, { role: 'ADMIN' });
    const unowned = await factories.createPage(adminOf.id, { title: 'Theirs', type: 'DOCUMENT' });

    const [agentId] = await provisionedAgentIds(user.id);

    expect(await getAgentAccessLevel(agentId, doc.id)).toEqual({
      canView: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
    });
    expect(await getAgentAccessLevel(agentId, secret.id)).toBeNull();
    expect(await hasAgentDriveAdminRole(agentId, owned.id)).toBe(false);
    // Negative control: the user's own ADMIN membership does not reach the agent.
    expect(await getAgentAccessLevel(agentId, unowned.id)).toBeNull();
  });
});

describe('Imago agent grants on ownership transfer (real Postgres)', () => {
  async function transferredDrive() {
    const { user: from } = await userWithHome();
    const { user: to } = await userWithHome();
    const drive = await factories.createDrive(from.id, { name: 'Handed over' });
    await factories.createDriveMember(drive.id, to.id, { role: 'ADMIN' });
    const fromAgents = await provisionedAgentIds(from.id);
    const toAgents = await provisionedAgentIds(to.id);
    return { from, to, drive, fromAgents, toAgents };
  }

  it('given a transfer, should revoke the previous owner\'s Imago agent grants in the drive', async () => {
    if (!dbAvailable) return;
    const { from, to, drive, fromAgents } = await transferredDrive();
    expect(await grantedDriveIds(fromAgents, drive.id)).toEqual([...fromAgents].sort());

    const revoked = await transferDriveOwnership(drive.id, from.id, to.id);

    expect([...revoked].sort()).toEqual([...fromAgents].sort());
    const [row] = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, drive.id));
    expect(row.ownerId).toBe(to.id);
    expect(await grantedDriveIds(fromAgents, drive.id)).toEqual([]);
  });

  it('given a transfer, should not silently re-grant the previous owner\'s agents when they re-provision', async () => {
    if (!dbAvailable) return;
    const { from, to, drive, fromAgents } = await transferredDrive();
    await transferDriveOwnership(drive.id, from.id, to.id);

    await provisionHomeDriveIfNeeded(from.id);
    await provisionImagoAgents(from.id);
    await grantImagoAgentsToOwnedDrives(from.id);

    expect(await grantedDriveIds(fromAgents, drive.id)).toEqual([]);
  });

  it('given a transfer, should leave the new owner\'s agents ungranted until the new owner grants them', async () => {
    if (!dbAvailable) return;
    const { from, to, drive, toAgents } = await transferredDrive();
    await transferDriveOwnership(drive.id, from.id, to.id);

    await provisionHomeDriveIfNeeded(to.id);
    await provisionImagoAgents(to.id);
    expect(await grantedDriveIds(toAgents, drive.id)).toEqual([]);

    // The new owner's own decision (the IMG-4.6 toggle path) still works.
    const granted = await addAgentToDrive({ actingUserId: to.id, agentPageId: toAgents[0], driveId: drive.id, requestedRole: 'MEMBER' });
    expect(granted.ok).toBe(true);
  });

  it('given a transfer, should keep a non-Imago agent grant the previous owner made explicitly', async () => {
    if (!dbAvailable) return;
    const { from, to, drive } = await transferredDrive();
    const [fromHome] = await db.select({ id: drives.id }).from(drives).where(and(eq(drives.ownerId, from.id), eq(drives.kind, 'HOME')));
    const classic = await factories.createPage(fromHome.id, { title: 'Classic agent', type: 'AI_CHAT' });
    const explicit = await addAgentToDrive({ actingUserId: from.id, agentPageId: classic.id, driveId: drive.id });
    expect(explicit.ok).toBe(true);

    await transferDriveOwnership(drive.id, from.id, to.id);

    expect(await grantedDriveIds([classic.id], drive.id)).toEqual([classic.id]);
  });

  it('given revokeImagoAgentGrants for a drive, should touch only that user\'s Imago agents in that drive', async () => {
    if (!dbAvailable) return;
    const { user } = await userWithHome();
    const keep = await factories.createDrive(user.id, { name: 'Keep' });
    const drop = await factories.createDrive(user.id, { name: 'Drop' });
    const ids = await provisionedAgentIds(user.id);

    const revoked = await revokeImagoAgentGrants(db, user.id, drop.id);

    expect([...revoked].sort()).toEqual([...ids].sort());
    expect(await grantedDriveIds(ids, drop.id)).toEqual([]);
    expect(await grantedDriveIds(ids, keep.id)).toEqual([...ids].sort());
  });

  it("given revokeImagoAgentGrants on the agents' own Home drive, should leave their native Home membership in place", async () => {
    if (!dbAvailable) return;
    const { user, home } = await userWithHome();
    const ids = await provisionedAgentIds(user.id);
    expect(await grantedDriveIds(ids, home.id)).toEqual([...ids].sort());

    const revoked = await revokeImagoAgentGrants(db, user.id, home.id);

    expect(revoked).toEqual([]);
    expect(await grantedDriveIds(ids, home.id)).toEqual([...ids].sort());
  });

  it('given a Home drive, should refuse to transfer it and change nothing', async () => {
    if (!dbAvailable) return;
    const { user: from, home } = await userWithHome();
    const { user: to } = await userWithHome();
    await factories.createDriveMember(home.id, to.id, { role: 'ADMIN' });
    const ids = await provisionedAgentIds(from.id);

    await expect(transferDriveOwnership(home.id, from.id, to.id)).rejects.toThrow(/Home/);

    const [row] = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, home.id));
    expect(row.ownerId).toBe(from.id);
    expect(await grantedDriveIds(ids, home.id)).toEqual([...ids].sort());
  });

  it("given a caller's transaction, should transfer and revoke inside it and roll back with it", async () => {
    if (!dbAvailable) return;
    const { from, to, drive, fromAgents } = await transferredDrive();

    await expect(db.transaction(async (tx) => {
      const revoked = await transferDriveOwnership(drive.id, from.id, to.id, tx);
      expect([...revoked].sort()).toEqual([...fromAgents].sort());
      throw new Error('caller aborts');
    })).rejects.toThrow('caller aborts');

    const [row] = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, drive.id));
    expect(row.ownerId).toBe(from.id);
    expect(await grantedDriveIds(fromAgents, drive.id)).toEqual([...fromAgents].sort());

    await db.transaction((tx) => transferDriveOwnership(drive.id, from.id, to.id, tx));
    const [after] = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, drive.id));
    expect(after.ownerId).toBe(to.id);
    expect(await grantedDriveIds(fromAgents, drive.id)).toEqual([]);
  });
});

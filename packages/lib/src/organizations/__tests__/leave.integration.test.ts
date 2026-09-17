/**
 * Leave and delete cascades against real Postgres (Spec O-7, O-8, ORG-6).
 *
 * The property only a database can prove: drives.ownerId is ON DELETE CASCADE, so deleting a
 * lead's users row hard-deletes an org drive unless the lead is reassigned first, in the same
 * transaction. A mocked executor would stay green with the reassignment removed.
 *
 * Requires DATABASE_URL → a migrated Postgres. Fails loudly when none is reachable (requireDb).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users, mcpTokens } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers, driveAgentMembers, mcpTokenDrives } from '@pagespace/db/schema/members';
import { driveShareLinks, pageShareLinks } from '@pagespace/db/schema/share-links';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { leaveOrganization, reassignLedOrgDrives, LeaveOrganizationRefusedError } from '../leave';
import { accountRepository } from '../../repositories/account-repository';

let dbAvailable = false;
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

async function user() {
  const u = await factories.createUser();
  createdUserIds.push(u.id);
  return u;
}

async function orgWith(ownerId: string, memberIds: string[]) {
  const [org] = await db.insert(organizations).values({
    name: 'Northwind Labs',
    slug: `northwind-${createId()}`,
    ownerId,
  }).returning();
  createdOrgIds.push(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: ownerId, role: 'OWNER' },
    ...memberIds.map((userId) => ({ orgId: org.id, userId, role: 'MEMBER' as const })),
  ]);
  return org;
}

/** One of each artifact the leaver can hand out, in `driveId`, created by `userId`. */
async function seedArtifacts(driveId: string, userId: string, agentHomeDriveId: string) {
  const agent = await factories.createPage(agentHomeDriveId, { type: 'AI_CHAT' });
  const [agentMembership] = await db.insert(driveAgentMembers)
    .values({ driveId, agentPageId: agent.id, addedBy: userId }).returning();
  const [driveLink] = await db.insert(driveShareLinks)
    .values({ driveId, token: `dl-${createId()}`, createdBy: userId }).returning();
  const page = await factories.createPage(driveId);
  const [pageLink] = await db.insert(pageShareLinks)
    .values({ pageId: page.id, token: `pl-${createId()}`, permissions: ['VIEW'], createdBy: userId }).returning();
  const [token] = await db.insert(mcpTokens)
    .values({ userId, tokenHash: `h-${createId()}`, tokenPrefix: 'mcp_', name: 'key' }).returning();
  const [tokenDrive] = await db.insert(mcpTokenDrives)
    .values({ tokenId: token.id, driveId }).returning();
  return { agentMembership, driveLink, pageLink, tokenDrive };
}

async function artifactsPresent(a: Awaited<ReturnType<typeof seedArtifacts>>) {
  const [agent, dl, pl, td] = await Promise.all([
    db.select().from(driveAgentMembers).where(eq(driveAgentMembers.id, a.agentMembership.id)),
    db.select().from(driveShareLinks).where(eq(driveShareLinks.id, a.driveLink.id)),
    db.select().from(pageShareLinks).where(eq(pageShareLinks.id, a.pageLink.id)),
    db.select().from(mcpTokenDrives).where(eq(mcpTokenDrives.id, a.tokenDrive.id)),
  ]);
  return {
    agentMembership: agent.length === 1,
    driveShareLink: dl.length === 1,
    pageShareLink: pl.length === 1,
    mcpTokenDriveRow: td.length === 1,
  };
}

const allPresent = { agentMembership: true, driveShareLink: true, pageShareLink: true, mcpTokenDriveRow: true };
const allGone = { agentMembership: false, driveShareLink: false, pageShareLink: false, mcpTokenDriveRow: false };

describe('leave and delete cascades (Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select().from(users).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('leave.integration.test.ts', error);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // drives.orgId and organizations.ownerId both RESTRICT: drives, then orgs, then users.
    if (createdOrgIds.length > 0) {
      await db.delete(drives).where(inArray(drives.orgId, createdOrgIds));
      await db.delete(organizations).where(inArray(organizations.id, createdOrgIds));
    }
    if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
  });

  it('O-8 leaving an org revokes all four artifact types the leaver handed out in its drives', async () => {
    if (!dbAvailable) return;
    const owner = await user();
    const leaver = await user();
    const org = await orgWith(owner.id, [leaver.id]);
    const orgDrive = await factories.createDrive(owner.id, { orgId: org.id });
    const leaverHome = await factories.createDrive(leaver.id);
    const [orgRow] = await db.insert(driveMembers)
      .values({ driveId: orgDrive.id, userId: leaver.id, source: 'org', acceptedAt: new Date() }).returning();
    const seeded = await seedArtifacts(orgDrive.id, leaver.id, leaverHome.id);
    expect(await artifactsPresent(seeded)).toEqual(allPresent);

    const result = await leaveOrganization(leaver.id, org.id);

    expect(result).toMatchObject({
      ok: true,
      revoked: { orgMembershipRows: 1, agentMemberships: 1, driveShareLinks: 1, pageShareLinks: 1, mcpTokenDriveRows: 1 },
    });
    expect(await artifactsPresent(seeded)).toEqual(allGone);
    expect(await db.select().from(driveMembers).where(eq(driveMembers.id, orgRow.id))).toEqual([]);
    expect(await db.select().from(orgMembers)
      .where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, leaver.id)))).toEqual([]);
  });

  it('O-8 a leaver\'s own invite rows and artifacts in non-org drives are untouched, as are other members\' in the org', async () => {
    if (!dbAvailable) return;
    const owner = await user();
    const leaver = await user();
    const outsider = await user();
    const colleague = await user();
    const org = await orgWith(owner.id, [leaver.id, colleague.id]);
    const orgDrive = await factories.createDrive(owner.id, { orgId: org.id });
    const personalDrive = await factories.createDrive(outsider.id);
    const leaverHome = await factories.createDrive(leaver.id);
    const colleagueHome = await factories.createDrive(colleague.id);
    const invite = await factories.createDriveMember(personalDrive.id, leaver.id, { source: 'invite' });
    const outside = await seedArtifacts(personalDrive.id, leaver.id, leaverHome.id);
    const colleagues = await seedArtifacts(orgDrive.id, colleague.id, colleagueHome.id);

    const result = await leaveOrganization(leaver.id, org.id);

    expect(result.ok).toBe(true);
    expect(await artifactsPresent(outside)).toEqual(allPresent);
    expect(await artifactsPresent(colleagues)).toEqual(allPresent);
    expect(await db.select().from(driveMembers).where(eq(driveMembers.id, invite.id))).toHaveLength(1);
  });

  it('O-7 leaving an org reassigns the drives the leaver leads to the org Owner with an audit event', async () => {
    if (!dbAvailable) return;
    const owner = await user();
    const lead = await user();
    const org = await orgWith(owner.id, [lead.id]);
    const led = await factories.createDrive(lead.id, { orgId: org.id });
    const personal = await factories.createDrive(lead.id);

    const result = await leaveOrganization(lead.id, org.id);

    expect(result).toMatchObject({ ok: true, reassigned: [{ driveId: led.id, fromUserId: lead.id, toUserId: owner.id }] });
    const [after] = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, led.id));
    expect(after.ownerId).toBe(owner.id);
    const [personalAfter] = await db.select({ ownerId: drives.ownerId }).from(drives).where(eq(drives.id, personal.id));
    expect(personalAfter.ownerId).toBe(lead.id);
    const events = await db.select().from(activityLogs)
      .where(and(eq(activityLogs.resourceId, led.id), eq(activityLogs.operation, 'ownership_transfer')));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      previousValues: { ownerId: lead.id },
      newValues: { ownerId: owner.id },
      metadata: { orgId: org.id, reason: 'left_org' },
    });
  });

  it('O-8 an org Owner cannot leave and nothing changes', async () => {
    if (!dbAvailable) return;
    const owner = await user();
    const org = await orgWith(owner.id, []);

    expect(await leaveOrganization(owner.id, org.id)).toEqual({ ok: false, reason: 'OWNER_MUST_TRANSFER' });
    expect(await db.select().from(orgMembers).where(eq(orgMembers.orgId, org.id))).toHaveLength(1);
  });

  it('ORG-6 (partial) deleting a lead\'s account keeps the org drive and makes the org Owner its lead', async () => {
    if (!dbAvailable) return;
    const owner = await user();
    const lead = await user();
    const org = await orgWith(owner.id, [lead.id]);
    const led = await factories.createDrive(lead.id, { orgId: org.id });
    const trashedLed = await factories.createDrive(lead.id, { orgId: org.id, isTrashed: true, trashedAt: new Date() });

    await accountRepository.deleteUser(lead.id);

    expect(await db.select().from(users).where(eq(users.id, lead.id))).toEqual([]);
    const after = await db.select({ id: drives.id, ownerId: drives.ownerId, orgId: drives.orgId })
      .from(drives).where(inArray(drives.id, [led.id, trashedLed.id]));
    expect(after).toHaveLength(2);
    for (const d of after) expect(d).toMatchObject({ ownerId: owner.id, orgId: org.id });
    const events = await db.select().from(activityLogs)
      .where(and(eq(activityLogs.resourceId, led.id), eq(activityLogs.operation, 'ownership_transfer')));
    expect(events[0]).toMatchObject({ userId: null, metadata: { orgId: org.id, reason: 'account_deleted' } });
    expect(events[0].actorEmail).not.toBe(lead.email);
  });

  it('ORG-6 (partial) an org Owner\'s account deletion is refused and changes nothing', async () => {
    if (!dbAvailable) return;
    const owner = await user();
    const org = await orgWith(owner.id, []);
    const drive = await factories.createDrive(owner.id, { orgId: org.id });

    await expect(accountRepository.deleteUser(owner.id)).rejects.toBeInstanceOf(LeaveOrganizationRefusedError);

    expect(await db.select().from(users).where(eq(users.id, owner.id))).toHaveLength(1);
    expect(await db.select().from(drives).where(eq(drives.id, drive.id))).toHaveLength(1);
  });

  it('ORG-6 (partial) erasure drive disposition never counts or deletes an org drive the user leads', async () => {
    if (!dbAvailable) return;
    const owner = await user();
    const lead = await user();
    const org = await orgWith(owner.id, [lead.id]);
    const soloOrgDrive = await factories.createDrive(lead.id, { orgId: org.id });
    const soloPersonal = await factories.createDrive(lead.id);

    expect((await accountRepository.getOwnedDrives(lead.id)).map((d) => d.id)).toEqual([soloPersonal.id]);
    await accountRepository.checkAndDeleteSoloDrives(lead.id);

    expect(await db.select().from(drives).where(eq(drives.id, soloOrgDrive.id))).toHaveLength(1);
    expect(await db.select().from(drives).where(eq(drives.id, soloPersonal.id))).toEqual([]);
  });

  it('O-7 reassignLedOrgDrives with no org given reassigns led drives across every org, each to its own Owner', async () => {
    if (!dbAvailable) return;
    const ownerA = await user();
    const ownerB = await user();
    const lead = await user();
    const orgA = await orgWith(ownerA.id, [lead.id]);
    const orgB = await orgWith(ownerB.id, [lead.id]);
    const driveA = await factories.createDrive(lead.id, { orgId: orgA.id });
    const driveB = await factories.createDrive(lead.id, { orgId: orgB.id });

    await db.transaction((tx) => reassignLedOrgDrives(lead.id, tx));

    const rows = await db.select({ id: drives.id, ownerId: drives.ownerId })
      .from(drives).where(inArray(drives.id, [driveA.id, driveB.id]));
    expect(Object.fromEntries(rows.map((r) => [r.id, r.ownerId])))
      .toEqual({ [driveA.id]: ownerA.id, [driveB.id]: ownerB.id });
  });
});

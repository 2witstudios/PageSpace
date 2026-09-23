/**
 * Visibility changes and lead changes on org drives — REAL Postgres, production wiring (the real org
 * membership sync), Spec DRV-4, DRV-5..7, DRV-1, D-OW-7.
 *
 * The decisions are unit-tested in organizations/__tests__/org-drive-visibility-lead.test.ts. This
 * file proves what the rows and resolvers do after each change: every visibility transition makes
 * materialized rows appear or disappear and the drive resolve (or stop resolving) for exactly the
 * right people; a lead change moves drives.ownerId and removes the former lead's OWNER row in one
 * transaction, leaving each person with only their own membership.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/services/__tests__/org-drive-visibility-lead.integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray, or } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, type OrgDriveVisibility } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { activityLogs } from '@pagespace/db/schema/monitoring';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { changeDriveVisibility, changeOrgDriveLead } from '../org-drive-service';
import { orgDriveServiceDeps, publishLeadChangeEvents } from '../org-drive-service-deps';
import { syncDriveOrgMembership, type OrgMembershipSyncPorts } from '../org-membership-sync';
import type { AffectedUser } from '../org-membership-sync-core';
import { getDriveRecipientUserIds } from '../drive-member-service';
import { listAccessibleDrives } from '../drive-service';
import { getUserDriveAccess } from '../../permissions/permissions';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

// Northwind Labs (Sequence Spec Part 2), per-run ids. Marcus leads Product. Jono owns the org,
// Priya is an Admin, Lena and Nina are members, Eve is a member whose join was approved (a direct
// row), Chris is a guest outside the org.
const run = createId().slice(0, 8);
const jono = createId();
const priya = createId();
const marcus = createId();
const lena = createId();
const nina = createId();
const eve = createId();
const chris = createId();
const northwind = createId();
const userIds = [jono, priya, marcus, lena, nina, eve, chris];
let product: string;

async function cleanup() {
  const ours = await db.select({ id: drives.id }).from(drives).where(or(eq(drives.orgId, northwind), inArray(drives.ownerId, userIds)));
  if (ours.length > 0) await db.delete(activityLogs).where(inArray(activityLogs.resourceId, ours.map((d) => d.id)));
  await db.delete(drives).where(or(eq(drives.orgId, northwind), inArray(drives.ownerId, userIds)));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, northwind));
  await db.delete(organizations).where(eq(organizations.id, northwind));
  await db.delete(users).where(inArray(users.id, userIds));
}

async function seedDrive(orgVisibility: OrgDriveVisibility, ownerId = marcus): Promise<string> {
  const id = createId();
  await db.insert(drives).values({ id, name: 'Product', slug: `product-${run}-${id.slice(0, 6)}`, ownerId, orgId: northwind, orgVisibility, updatedAt: new Date() });
  await db.insert(driveMembers).values([
    { driveId: id, userId: eve, role: 'MEMBER', source: 'invite', acceptedAt: new Date() },
    { driveId: id, userId: chris, role: 'MEMBER', source: 'invite', acceptedAt: new Date() },
  ]);
  await syncDriveOrgMembership(id);
  return id;
}

beforeEach(async () => {
  await cleanup();
  await db.insert(users).values(userIds.map((id, i) => ({ id, email: `u${i}-${run}@northwind.test`, name: `User ${i}`, updatedAt: new Date() })));
  await db.insert(organizations).values({ id: northwind, name: 'Northwind Labs', slug: `northwind-${run}`, ownerId: jono });
  await db.insert(orgMembers).values([
    { orgId: northwind, userId: jono, role: 'OWNER' },
    { orgId: northwind, userId: priya, role: 'ADMIN' },
    { orgId: northwind, userId: marcus, role: 'MEMBER' },
    { orgId: northwind, userId: lena, role: 'MEMBER' },
    { orgId: northwind, userId: nina, role: 'MEMBER' },
    { orgId: northwind, userId: eve, role: 'MEMBER' },
  ]);
  product = await seedDrive('OPEN');
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function rowsBySource(driveId: string) {
  const rows = await db.select({ userId: driveMembers.userId, source: driveMembers.source }).from(driveMembers).where(eq(driveMembers.driveId, driveId));
  return {
    org: rows.filter((r) => r.source === 'org').map((r) => r.userId).sort(),
    invite: rows.filter((r) => r.source === 'invite').map((r) => r.userId).sort(),
  };
}

async function resolvesFor(driveId: string, people: string[]) {
  return Object.fromEntries(await Promise.all(people.map(async (u) => [u, await getUserDriveAccess(u, driveId)] as const)));
}

const sorted = (ids: string[]) => [...ids].sort();

/** Who holds what, and who resolves, on a drive at each visibility (DRV-5, DRV-6, DRV-7, ORG-4). */
const EXPECTED: Record<OrgDriveVisibility, { org: string[]; resolves: Record<string, boolean> }> = {
  OPEN: {
    org: sorted([jono, priya, lena, nina]),
    resolves: { [marcus]: true, [jono]: true, [priya]: true, [lena]: true, [nina]: true, [eve]: true, [chris]: true },
  },
  RESTRICTED: {
    org: [],
    resolves: { [marcus]: true, [jono]: true, [priya]: true, [lena]: false, [nina]: false, [eve]: true, [chris]: true },
  },
  PRIVATE: {
    org: [],
    resolves: { [marcus]: true, [jono]: true, [priya]: true, [lena]: false, [nina]: false, [eve]: true, [chris]: true },
  },
};

const VISIBILITIES: OrgDriveVisibility[] = ['OPEN', 'RESTRICTED', 'PRIVATE'];
const TRANSITIONS = VISIBILITIES.flatMap((from) => VISIBILITIES.filter((to) => to !== from).map((to) => [from, to] as const));

describe('changeDriveVisibility', () => {
  it.each(TRANSITIONS)('DRV-4 (partial) %s to %s: materialized rows follow and the drive resolves for exactly the right people', async (from, to) => {
    const driveId = await seedDrive(from);
    expect((await rowsBySource(driveId)).org).toEqual(EXPECTED[from].org);

    const result = await changeDriveVisibility(priya, driveId, { orgVisibility: to }, orgDriveServiceDeps);

    expect(result).toMatchObject({ ok: true, changed: true, from, to, drive: { orgVisibility: to } });
    const rows = await rowsBySource(driveId);
    expect(rows.org).toEqual(EXPECTED[to].org);
    // Direct rows (an approved join, a guest) survive every change.
    expect(rows.invite).toEqual(sorted([eve, chris]));
    expect(await resolvesFor(driveId, userIds)).toEqual(EXPECTED[to].resolves);
    const recipients = await getDriveRecipientUserIds(driveId);
    for (const [userId, resolves] of Object.entries(EXPECTED[to].resolves)) {
      expect(recipients.includes(userId), `${userId} recipient after ${from}->${to}`).toBe(resolves);
    }
  });

  it('DRV-6 (partial) a Restricted drive leaves the plain member\'s picker and sidebar; turning it Open again brings it back', async () => {
    const listed = async () => (await listAccessibleDrives(lena)).some((d) => d.id === product);
    expect(await listed()).toBe(true);

    await changeDriveVisibility(marcus, product, { orgVisibility: 'RESTRICTED' }, orgDriveServiceDeps);
    expect(await listed()).toBe(false);

    await changeDriveVisibility(marcus, product, { orgVisibility: 'OPEN' }, orgDriveServiceDeps);
    expect(await listed()).toBe(true);
  });

  it('DRV-7 (partial) a change to Private removes the org rows and the drive stops resolving for members without a row', async () => {
    await changeDriveVisibility(jono, product, { orgVisibility: 'PRIVATE' }, orgDriveServiceDeps);

    expect(await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, product), eq(driveMembers.userId, lena)))).toEqual([]);
    expect(await getUserDriveAccess(lena, product)).toBe(false);
    expect(await getUserDriveAccess(eve, product)).toBe(true);
  });

  it('DRV-4 (partial) a plain org member and an outsider are refused and nothing changes', async () => {
    const before = await rowsBySource(product);

    expect(await changeDriveVisibility(lena, product, { orgVisibility: 'PRIVATE' }, orgDriveServiceDeps))
      .toMatchObject({ ok: false, code: 'NOT_DRIVE_LEAD_OR_ORG_ADMIN', status: 403 });
    expect(await changeDriveVisibility(chris, product, { orgVisibility: 'PRIVATE' }, orgDriveServiceDeps))
      .toMatchObject({ ok: false, code: 'NOT_DRIVE_LEAD_OR_ORG_ADMIN', status: 403 });

    const [drive] = await db.select().from(drives).where(eq(drives.id, product));
    expect(drive.orgVisibility).toBe('OPEN');
    expect(await rowsBySource(product)).toEqual(before);
  });

  it('DRV-4 (partial) a personal drive has no org visibility to change', async () => {
    const personal = createId();
    await db.insert(drives).values({ id: personal, name: 'Notes', slug: `notes-${run}`, ownerId: marcus, updatedAt: new Date() });

    expect(await changeDriveVisibility(marcus, personal, { orgVisibility: 'PRIVATE' }, orgDriveServiceDeps))
      .toMatchObject({ ok: false, code: 'NOT_IN_ORG' });
    expect(await changeDriveVisibility(marcus, createId(), { orgVisibility: 'PRIVATE' }, orgDriveServiceDeps))
      .toMatchObject({ ok: false, code: 'DRIVE_NOT_FOUND', status: 404 });
  });
});

describe('changeOrgDriveLead', () => {
  const ownerRowsOf = (driveId: string, userId: string) =>
    db.select().from(driveMembers).where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId), eq(driveMembers.role, 'OWNER')));

  it('DRV-1 (partial) the lead hands an Open drive to a member: ownerId and the OWNER row move together, and the former lead stays in only as an org member', async () => {
    // Marcus's owner self-heal row, carried in from when Product was Marcus's personal drive.
    await db.insert(driveMembers).values({ driveId: product, userId: marcus, role: 'OWNER', acceptedAt: new Date() });

    const result = await changeOrgDriveLead(marcus, product, { newLeadId: lena }, orgDriveServiceDeps);

    expect(result).toMatchObject({ ok: true, changed: true, fromUserId: marcus, toUserId: lena, drive: { ownerId: lena } });
    expect(await ownerRowsOf(product, marcus)).toEqual([]);
    const rows = await rowsBySource(product);
    // The new lead holds no row; the former lead now has the org row every member of an Open drive has.
    expect(rows.org).toEqual(sorted([jono, priya, marcus, nina]));
    expect(await getUserDriveAccess(marcus, product)).toBe(true);
    const [event] = await db.select().from(activityLogs)
      .where(and(eq(activityLogs.resourceId, product), eq(activityLogs.operation, 'ownership_transfer')));
    expect(event).toMatchObject({ userId: marcus, previousValues: { ownerId: marcus }, newValues: { ownerId: lena } });
  });

  it('DRV-1 (partial) on a Restricted drive the former lead keeps no access through a leftover OWNER row', async () => {
    const research = await seedDrive('RESTRICTED');
    await db.insert(driveMembers).values({ driveId: research, userId: marcus, role: 'OWNER', acceptedAt: new Date() });

    expect(await changeOrgDriveLead(priya, research, { newLeadId: lena }, orgDriveServiceDeps)).toMatchObject({ ok: true, changed: true });

    expect(await ownerRowsOf(research, marcus)).toEqual([]);
    expect(await getUserDriveAccess(marcus, research)).toBe(false);
    expect(await getUserDriveAccess(lena, research)).toBe(true);
  });

  it('DRV-1 (partial) an org Admin may set the lead; a plain member may not, and nothing moves', async () => {
    expect(await changeOrgDriveLead(nina, product, { newLeadId: nina }, orgDriveServiceDeps))
      .toMatchObject({ ok: false, code: 'NOT_DRIVE_LEAD_OR_ORG_ADMIN', status: 403 });
    expect((await db.select().from(drives).where(eq(drives.id, product)))[0].ownerId).toBe(marcus);

    expect(await changeOrgDriveLead(priya, product, { newLeadId: nina }, orgDriveServiceDeps)).toMatchObject({ ok: true, toUserId: nina });
    expect((await db.select().from(drives).where(eq(drives.id, product)))[0].ownerId).toBe(nina);
  });

  it('D-OW-7 a new lead outside the org is refused and nothing moves', async () => {
    expect(await changeOrgDriveLead(marcus, product, { newLeadId: chris }, orgDriveServiceDeps))
      .toMatchObject({ ok: false, code: 'TARGET_NOT_ORG_MEMBER', status: 409 });
    expect((await db.select().from(drives).where(eq(drives.id, product)))[0].ownerId).toBe(marcus);
  });

  it('DRV-1 (partial) a personal drive is unaffected', async () => {
    const personal = createId();
    await db.insert(drives).values({ id: personal, name: 'Notes', slug: `notes-${run}`, ownerId: marcus, updatedAt: new Date() });
    await db.insert(driveMembers).values({ driveId: personal, userId: marcus, role: 'OWNER', acceptedAt: new Date() });

    expect(await changeOrgDriveLead(marcus, personal, { newLeadId: lena }, orgDriveServiceDeps)).toMatchObject({ ok: false, code: 'NOT_IN_ORG' });
    expect((await db.select().from(drives).where(eq(drives.id, personal)))[0].ownerId).toBe(marcus);
    expect(await ownerRowsOf(personal, marcus)).toHaveLength(1);
  });

  it('X-4 (partial) realtime tells both people; a former lead who lost access is kicked from the drive\'s rooms', async () => {
    const research = await seedDrive('RESTRICTED');
    await db.update(drives).set({ ownerId: lena }).where(eq(drives.id, research));
    const broadcasts: AffectedUser[] = [];
    const kicks: Array<{ userId: string; driveId: string }> = [];
    const ports: OrgMembershipSyncPorts = {
      broadcast: async (user) => { broadcasts.push(user); },
      kick: async (target) => { kicks.push(target); },
    };

    await publishLeadChangeEvents(research, marcus, lena, ports);
    expect(broadcasts).toEqual([
      { userId: lena, operation: 'member_role_changed', driveIds: [research] },
      { userId: marcus, operation: 'member_removed', driveIds: [research] },
    ]);
    expect(kicks).toEqual([{ userId: marcus, driveId: research }]);

    // On an Open drive the former lead is still a member: told, not kicked.
    broadcasts.length = 0;
    kicks.length = 0;
    await db.update(drives).set({ ownerId: lena }).where(eq(drives.id, product));
    await publishLeadChangeEvents(product, marcus, lena, ports);
    expect(broadcasts.map((b) => [b.userId, b.operation])).toEqual([[lena, 'member_role_changed'], [marcus, 'member_role_changed']]);
    expect(kicks).toEqual([]);
  });
});

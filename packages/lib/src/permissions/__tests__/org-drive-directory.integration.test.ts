/**
 * The org Drives directory and drive recipient lists — REAL Postgres (Spec DRV-5, DRV-6, DRV-7).
 *
 * Directory: which drives each org member sees there and how (joined, pending, requestable, lead).
 * Recipients: a pending invitation or a pending join request is not membership, so it puts nobody
 * in a drive's recipient list or co-member (DM) relationship; an org member with a pending direct
 * invitation on an OPEN drive is still a recipient through org membership (point-guard ruling on
 * #2688 thread 13), and accepting or declining that invitation behaves as it should.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/org-drive-directory.integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray, or } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, type OrgDriveVisibility } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { listOrgDriveDirectory } from '../org-drive-directory';
import { usersShareDrive } from '../permissions';
import { answerDriveJoinRequest, requestToJoinDrive } from '../../services/drive-join-request-service';
import { getDriveMemberUserIds, getDriveRecipientUserIds } from '../../services/drive-member-service';
import { getDriveAccess, listAccessibleDrives } from '../../services/drive-service';
import { syncDriveOrgMembership } from '../../services/org-membership-sync';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

// Northwind Labs (Sequence Spec Part 2), per-run ids. Marcus leads every drive. Jono owns the org,
// Priya is an Admin, Lena, Nina and Eve are members, Chris is outside the org.
const run = createId().slice(0, 8);
const jono = createId();
const priya = createId();
const marcus = createId();
const lena = createId();
const nina = createId();
const eve = createId();
const chris = createId();
const olga = createId();
const northwind = createId();
const userIds = [jono, priya, marcus, lena, nina, eve, chris, olga];
const d: Record<'product' | 'research' | 'finance' | 'archive', string> = { product: '', research: '', finance: '', archive: '' };

async function cleanup() {
  await db.delete(drives).where(or(eq(drives.orgId, northwind), inArray(drives.ownerId, userIds)));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, northwind));
  await db.delete(organizations).where(eq(organizations.id, northwind));
  await db.delete(users).where(inArray(users.id, userIds));
}

async function seedDrive(name: string, orgVisibility: OrgDriveVisibility, isTrashed = false) {
  const id = createId();
  await db.insert(drives).values({ id, name, slug: `${name.toLowerCase()}-${run}`, ownerId: marcus, orgId: northwind, orgVisibility, isTrashed, updatedAt: new Date() });
  return id;
}

beforeEach(async () => {
  await cleanup();
  const names = ['Jono', 'Priya Nair', 'Marcus Oyelaran', 'Lena Park', 'Nina Brandt', 'Eve Santos', 'Chris Rowe', 'Olga Petrova'];
  await db.insert(users).values(userIds.map((id, i) => ({ id, email: `u${i}-${run}@northwind.test`, name: names[i], updatedAt: new Date() })));
  await db.insert(organizations).values({ id: northwind, name: 'Northwind Labs', slug: `northwind-${run}`, ownerId: jono });
  await db.insert(orgMembers).values([
    { orgId: northwind, userId: jono, role: 'OWNER' },
    { orgId: northwind, userId: priya, role: 'ADMIN' },
    { orgId: northwind, userId: marcus, role: 'MEMBER' },
    { orgId: northwind, userId: lena, role: 'MEMBER' },
    { orgId: northwind, userId: nina, role: 'MEMBER' },
    { orgId: northwind, userId: eve, role: 'MEMBER' },
  ]);
  d.product = await seedDrive('Product', 'OPEN');
  d.research = await seedDrive('Research', 'RESTRICTED');
  d.finance = await seedDrive('Finance', 'PRIVATE');
  d.archive = await seedDrive('Archive', 'RESTRICTED', true);
  // Eve was invited to Finance; Chris is a guest on Research.
  await db.insert(driveMembers).values([
    { driveId: d.finance, userId: eve, role: 'MEMBER', source: 'invite', acceptedAt: new Date() },
    { driveId: d.research, userId: chris, role: 'MEMBER', source: 'invite', acceptedAt: new Date() },
  ]);
  await syncDriveOrgMembership(d.product);
});

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await pool.end();
});

async function directoryOf(userId: string) {
  const entries = await listOrgDriveDirectory(northwind, userId);
  return entries === null
    ? null
    : Object.fromEntries(entries.map((e) => [e.name, { visibility: e.orgVisibility, joined: e.joined, joinRequest: e.joinRequest, canRequest: e.canRequest }]));
}

describe('listOrgDriveDirectory', () => {
  it('DRV-6 (partial) a plain member sees Open joined and Restricted requestable; never a Private drive or a trashed one', async () => {
    expect(await directoryOf(lena)).toEqual({
      Product: { visibility: 'OPEN', joined: true, joinRequest: null, canRequest: false },
      Research: { visibility: 'RESTRICTED', joined: false, joinRequest: null, canRequest: true },
    });
  });

  it('DRV-6 (partial) someone outside the org sees no directory, even while a guest on one of its drives', async () => {
    expect(await listOrgDriveDirectory(northwind, chris)).toBeNull();
  });

  it('DRV-7 (partial) the org Owner and Admins see Private drives; an invited member sees the Private drive they are on', async () => {
    for (const admin of [jono, priya]) {
      expect((await directoryOf(admin))?.Finance).toEqual({ visibility: 'PRIVATE', joined: false, joinRequest: null, canRequest: false });
    }
    expect((await directoryOf(eve))?.Finance).toEqual({ visibility: 'PRIVATE', joined: true, joinRequest: null, canRequest: false });
    expect(await directoryOf(nina)).not.toHaveProperty('Finance');
  });

  it('DRV-6 (partial) each entry names its lead', async () => {
    const entries = await listOrgDriveDirectory(northwind, lena);
    expect(entries?.map((e) => e.lead)).toEqual([
      { id: marcus, name: 'Marcus Oyelaran', image: null },
      { id: marcus, name: 'Marcus Oyelaran', image: null },
    ]);
  });

  it('DRV-6 (partial) a pending request shows as pending; an approved join makes the drive joined, resolvable and listed in the picker', async () => {
    const requested = await requestToJoinDrive(lena, d.research);
    if (!requested.ok) throw new Error(requested.code);
    expect((await directoryOf(lena))?.Research).toEqual({ visibility: 'RESTRICTED', joined: false, joinRequest: 'pending', canRequest: false });
    expect((await listAccessibleDrives(lena)).map((x) => x.id)).not.toContain(d.research);

    await answerDriveJoinRequest(marcus, d.research, requested.request.id, 'approve');

    expect((await directoryOf(lena))?.Research).toEqual({ visibility: 'RESTRICTED', joined: true, joinRequest: null, canRequest: false });
    expect((await listAccessibleDrives(lena)).map((x) => x.id)).toContain(d.research);
    expect(await getDriveAccess(d.research, lena)).toMatchObject({ isMember: true, role: 'MEMBER' });
  });

  it('DRV-6 (partial) a Restricted drive is in the directory but never in the picker or sidebar for a member who has not joined, even an org Admin', async () => {
    for (const userId of [lena, priya]) {
      expect((await listAccessibleDrives(userId)).map((x) => x.id)).not.toContain(d.research);
      expect(await directoryOf(userId)).toHaveProperty('Research');
    }
  });
});

describe('drive recipient lists', () => {
  it('DRV-6 (partial) a pending join request puts nobody in the recipient list, the member list or a co-member (DM) relationship', async () => {
    const requested = await requestToJoinDrive(lena, d.research);
    expect(requested.ok).toBe(true);

    expect(await getDriveRecipientUserIds(d.research)).not.toContain(lena);
    expect(await getDriveMemberUserIds(d.research)).not.toContain(lena);
    expect(await usersShareDrive(lena, chris)).toBe(false);
    expect(await usersShareDrive(chris, lena)).toBe(false);
  });

  it('DRV-7 (partial) a pending invitation is not membership: its holder is no recipient and no co-member of anyone on the drive', async () => {
    // Olga is outside the org, invited to Finance as ADMIN and has not accepted.
    await db.insert(driveMembers).values({ driveId: d.finance, userId: olga, role: 'ADMIN', invitedBy: marcus });

    expect(await getDriveRecipientUserIds(d.finance)).not.toContain(olga);
    expect(await usersShareDrive(olga, eve)).toBe(false);
    expect(await usersShareDrive(olga, marcus)).toBe(false);
  });

  it('DRV-5 (partial) an org member with a pending direct invitation on an Open drive is still a recipient through org membership', async () => {
    // Nina's org row gives way to a pending direct invitation (B4 never rewrites it on their behalf).
    await db.delete(driveMembers).where(and(eq(driveMembers.driveId, d.product), eq(driveMembers.userId, nina)));
    await db.insert(driveMembers).values({ driveId: d.product, userId: nina, role: 'ADMIN', invitedBy: marcus });
    await syncDriveOrgMembership(d.product);
    const [pending] = await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, d.product), eq(driveMembers.userId, nina)));
    expect(pending).toMatchObject({ source: 'invite', role: 'ADMIN', acceptedAt: null });

    expect(await getDriveRecipientUserIds(d.product)).toContain(nina);
    expect(await getDriveAccess(d.product, nina)).toMatchObject({ isMember: true, role: 'MEMBER' });
  });

  it('DRV-5 (partial) accepting that invitation makes it their direct row with its own role; declining leaves their org-derived access intact', async () => {
    const [defaultRole] = await db.insert(driveRoles).values({ driveId: d.product, name: 'Contributor', isDefault: true, permissions: {} }).returning();
    await db.delete(driveMembers).where(and(eq(driveMembers.driveId, d.product), inArray(driveMembers.userId, [nina, lena])));
    await db.insert(driveMembers).values([
      { driveId: d.product, userId: nina, role: 'ADMIN', invitedBy: marcus },
      { driveId: d.product, userId: lena, role: 'ADMIN', invitedBy: marcus },
    ]);

    // Nina accepts.
    await db.update(driveMembers).set({ acceptedAt: new Date() }).where(and(eq(driveMembers.driveId, d.product), eq(driveMembers.userId, nina)));
    // Lena declines: the invitation row goes.
    await db.delete(driveMembers).where(and(eq(driveMembers.driveId, d.product), eq(driveMembers.userId, lena)));
    await syncDriveOrgMembership(d.product);

    const rows = await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, d.product), inArray(driveMembers.userId, [nina, lena])));
    expect(rows.map((r) => [r.userId === nina ? 'nina' : 'lena', r.source, r.role]).sort()).toEqual([
      ['lena', 'org', 'MEMBER'],
      ['nina', 'invite', 'ADMIN'],
    ]);
    expect(await getDriveAccess(d.product, nina)).toMatchObject({ isAdmin: true, role: 'ADMIN' });
    expect(await getDriveAccess(d.product, lena)).toMatchObject({ isMember: true, role: 'MEMBER', customRoleId: defaultRole.id });
    const recipients = await getDriveRecipientUserIds(d.product);
    expect(recipients).toContain(nina);
    expect(recipients).toContain(lena);
  });
});

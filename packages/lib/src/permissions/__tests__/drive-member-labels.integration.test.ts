/**
 * Drive Members labels against a real Postgres (Spec DRV-8, UI-5, D-OW-24): each member carries
 * how they came (`source`) and whether they are a guest; page-link GUEST rows are listed apart,
 * by name, with the pages they hold. Northwind: Jono owns the org and leads Product; Marcus is an
 * org member materialized onto Product; Chris Rowe was invited and is not in the org; Pia
 * redeemed a page share link.
 *
 * Requires DATABASE_URL; deletes every row it creates, users last, and ends the pool.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { getDriveOwnerAsMember, listDriveMembers } from '../../services/drive-member-service';
import { listDrivePageLinkGuests } from '../drive-member-labels';
import { canViewDriveWallet } from '../spend-standing';
import { isDriveOwnerOrAdmin } from '../permissions';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

let ok = false;
const ids = { users: [] as string[], orgId: '', driveId: '', personalDriveId: '', pageId: '' };

describe('drive Members labels and page-link guests (real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: users.id }).from(users).limit(1);
      ok = true;
    } catch (error) {
      requireDb('drive-member-labels.integration.test.ts', error);
      return;
    }
    const jono = await factories.createUser({ name: 'Jono' });
    const marcus = await factories.createUser({ name: 'Marcus Oyelaran' });
    const chris = await factories.createUser({ name: 'Chris Rowe' });
    const pia = await factories.createUser({ name: 'Pia Page' });
    const leaver = await factories.createUser({ name: 'Lou Left' });
    const collab = await factories.createUser({ name: 'Cara Collaborator' });
    const outsider = await factories.createUser({ name: 'Otto Outside' });
    ids.users = [jono.id, marcus.id, chris.id, pia.id, leaver.id, collab.id, outsider.id];
    const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `nw-${createId()}`, ownerId: jono.id }).returning();
    ids.orgId = org.id;
    await db.insert(orgMembers).values([{ orgId: org.id, userId: jono.id, role: 'OWNER' }, { orgId: org.id, userId: marcus.id, role: 'MEMBER' }]);
    const product = await factories.createDrive(jono.id, { name: 'Product', slug: `p-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
    ids.driveId = product.id;
    await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
    await factories.createDriveMember(product.id, chris.id, { source: 'invite' });
    // Lou's row was materialized from org membership; Lou has since left the org (no org_members row).
    await factories.createDriveMember(product.id, leaver.id, { source: 'org' });
    await db.insert(driveMembers).values({ driveId: product.id, userId: pia.id, role: 'GUEST', source: 'invite', acceptedAt: new Date() });
    const page = await factories.createPage(product.id, { title: 'Roadmap' });
    ids.pageId = page.id;
    await db.insert(pagePermissions).values({ pageId: page.id, userId: pia.id, canView: true, canEdit: false, canShare: false });
    // Cara holds a page grant only: no drive_members row of any kind.
    await db.insert(pagePermissions).values({ pageId: page.id, userId: collab.id, canView: true, canEdit: false, canShare: false });
    const side = await factories.createDrive(jono.id, { name: 'Side', slug: `s-${createId()}` });
    ids.personalDriveId = side.id;
    await factories.createDriveMember(side.id, chris.id, { source: 'invite' });
  });

  afterAll(async () => {
    if (ok) {
      await db.delete(pagePermissions).where(inArray(pagePermissions.userId, ids.users));
      await db.delete(pages).where(inArray(pages.driveId, [ids.driveId, ids.personalDriveId]));
      await db.delete(driveMembers).where(inArray(driveMembers.driveId, [ids.driveId, ids.personalDriveId]));
      await db.delete(drives).where(inArray(drives.id, [ids.driveId, ids.personalDriveId]));
      await db.delete(orgMembers).where(eq(orgMembers.orgId, ids.orgId));
      await db.delete(organizations).where(eq(organizations.id, ids.orgId));
      await db.delete(users).where(inArray(users.id, ids.users));
    }
    await pool.end();
  });

  it('DRV-8 (partial) UI-5 (partial) on an org drive each member carries its source, and the invited outsider is labeled a guest; the org member is not; a departed member\'s stale row is not listed at all', async () => {
    if (!ok) return;
    const members = await listDriveMembers(ids.driveId);
    const byName = Object.fromEntries(members.map((m) => [m.user?.name, { source: m.source, isGuest: m.isGuest }]));
    expect(byName).toEqual({
      'Marcus Oyelaran': { source: 'org', isGuest: false },
      'Chris Rowe': { source: 'invite', isGuest: true },
    });
    expect(await getDriveOwnerAsMember(ids.driveId)).toMatchObject({ source: 'lead', isGuest: false });
  });

  it('DRV-8 (partial) on a personal drive nobody is a guest', async () => {
    if (!ok) return;
    expect((await listDriveMembers(ids.personalDriveId)).map((m) => m.isGuest)).toEqual([false]);
  });

  it('UI-5 (partial) a page-link GUEST (D-OW-24) is not a member but is listed apart, by name, with the pages it holds', async () => {
    if (!ok) return;
    expect((await listDriveMembers(ids.driveId)).some((m) => m.user?.name === 'Pia Page')).toBe(false);
    expect(await listDrivePageLinkGuests(ids.driveId)).toEqual([
      expect.objectContaining({ displayName: 'Pia Page', source: 'invite', pageGrantCount: 1 }),
    ]);
  });

  it('UI-5 (partial) each page-link guest lists the pages it holds in this drive, by title, with its role and expiry, so the lead can revoke one', async () => {
    if (!ok) return;
    const [pia] = await listDrivePageLinkGuests(ids.driveId);
    expect(pia.pages).toEqual([{ pageId: expect.any(String), title: 'Roadmap', role: 'view', expiresAt: null }]);
  });

  it('UI-5 (partial) the page-link guest list is gated to the lead and admins: a GUEST-role member is neither, so the members route answers it []', async () => {
    if (!ok) return;
    const piaId = ids.users[3];
    expect(await isDriveOwnerOrAdmin(piaId, ids.driveId)).toBe(false);
    expect(await isDriveOwnerOrAdmin(ids.users[0], ids.driveId)).toBe(true);
  });

  it('X-4 (partial) only people with a wallet view may join the drive wallet room: the lead, a member and an invited guest can; a page-grant collaborator, a page-link GUEST, a departed member and an outsider cannot', async () => {
    if (!ok) return;
    const [jono, marcus, chris, pia, lou, cara, otto] = ids.users;
    const can = async (userId: string) => canViewDriveWallet(userId, ids.driveId);
    expect(await Promise.all([jono, marcus, chris].map(can))).toEqual([true, true, true]);
    expect(await Promise.all([pia, lou, cara, otto].map(can))).toEqual([false, false, false, false]);
  });
});


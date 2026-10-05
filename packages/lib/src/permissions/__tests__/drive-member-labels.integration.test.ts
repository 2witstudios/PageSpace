/**
 * Drive Members labels against a real Postgres (Spec DRV-8, UI-5, D-OW-24): each member carries
 * how they came (`source`) and whether they are a guest; page-link GUEST rows are listed apart,
 * by name, with the pages they hold. Northwind: Jono owns the org and leads Product; Marcus is an
 * org member materialized onto Product; Chris Rowe was invited and is not in the org; Pia
 * redeemed a page share link.
 *
 * Requires DATABASE_URL; deletes every row it creates, users last, and ends the pool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
    ids.users = [jono.id, marcus.id, chris.id, pia.id];
    const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `nw-${createId()}`, ownerId: jono.id }).returning();
    ids.orgId = org.id;
    await db.insert(orgMembers).values([{ orgId: org.id, userId: jono.id, role: 'OWNER' }, { orgId: org.id, userId: marcus.id, role: 'MEMBER' }]);
    const product = await factories.createDrive(jono.id, { name: 'Product', slug: `p-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
    ids.driveId = product.id;
    await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
    await factories.createDriveMember(product.id, chris.id, { source: 'invite' });
    await db.insert(driveMembers).values({ driveId: product.id, userId: pia.id, role: 'GUEST', source: 'invite', acceptedAt: new Date() });
    const page = await factories.createPage(product.id, { title: 'Roadmap' });
    ids.pageId = page.id;
    await db.insert(pagePermissions).values({ pageId: page.id, userId: pia.id, canView: true, canEdit: false, canShare: false });
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

  it('DRV-8 (partial) UI-5 (partial) on an org drive each member carries its source, and the invited outsider is labeled a guest; the org member is not', async () => {
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
});

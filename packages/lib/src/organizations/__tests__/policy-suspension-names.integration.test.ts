/**
 * Suspended items carry names (Spec POL-1, UI-7) against a real Postgres: the drive's name where
 * the Drives directory shows it to the viewer, a suspended guest's decrypted name, and a label.
 * Requires DATABASE_URL; deletes what it creates, users last, and ends the pool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { nameSuspensions } from '../policy-suspension-names';
import type { SuspendedListing } from '../policy-suspension';

let ok = false;
const ids = { users: [] as string[], orgId: '', openId: '', privateId: '', adminId: '', memberId: '', guestId: '' };

describe('suspended items carry names (real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: users.id }).from(users).limit(1);
      ok = true;
    } catch (error) {
      requireDb('policy-suspension-names.integration.test.ts', error);
      return;
    }
    const admin = await factories.createUser({ name: 'Priya Nair' });
    const member = await factories.createUser({ name: 'Marcus Oyelaran' });
    const guest = await factories.createUser({ name: 'Chris Rowe' });
    Object.assign(ids, { adminId: admin.id, memberId: member.id, guestId: guest.id, users: [admin.id, member.id, guest.id] });
    const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `nw-${createId()}`, ownerId: admin.id }).returning();
    ids.orgId = org.id;
    await db.insert(orgMembers).values([{ orgId: org.id, userId: admin.id, role: 'OWNER' }, { orgId: org.id, userId: member.id, role: 'MEMBER' }]);
    ids.openId = (await factories.createDrive(admin.id, { name: 'Product', slug: `p-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' })).id;
    ids.privateId = (await factories.createDrive(admin.id, { name: 'Board Minutes', slug: `b-${createId()}`, orgId: org.id, orgVisibility: 'PRIVATE' })).id;
  });

  afterAll(async () => {
    if (ok) {
      await db.delete(drives).where(inArray(drives.id, [ids.openId, ids.privateId]));
      await db.delete(orgMembers).where(eq(orgMembers.orgId, ids.orgId));
      await db.delete(organizations).where(eq(organizations.id, ids.orgId));
      await db.delete(users).where(inArray(users.id, ids.users));
    }
    await pool.end();
  });

  const listings = (): SuspendedListing[] => [
    { kind: 'publicShareLinks', resourceType: 'page_share_link', total: 1, items: [{ kind: 'publicShareLinks', resourceType: 'page_share_link', id: 'l1', driveId: ids.privateId }] },
    { kind: 'guests', resourceType: 'guest_hold', total: 1, items: [{ kind: 'guests', resourceType: 'guest_hold', id: 'h1', driveId: ids.openId, userId: ids.guestId }] },
  ];

  it('UI-7 (partial) an Owner reads every suspended item by drive and person name, with a label', async () => {
    if (!ok) return;
    const named = await nameSuspensions(ids.orgId, ids.adminId, listings());
    expect(named.flatMap((l) => l.items.map((i) => [i.driveName, i.userName, i.label]))).toEqual([
      ['Board Minutes', null, 'Page share link in Board Minutes'],
      ['Product', 'Chris Rowe', 'Guest Chris Rowe in Product'],
    ]);
  });

  it('UI-7 (partial) a Private drive the viewer would not see in the Drives directory keeps no name', async () => {
    if (!ok) return;
    const named = await nameSuspensions(ids.orgId, ids.memberId, listings());
    expect(named[0].items[0]).toMatchObject({ driveName: null, label: 'Page share link' });
    expect(named[1].items[0]).toMatchObject({ driveName: 'Product' });
  });
});

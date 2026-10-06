/**
 * DRV-9 against a real Postgres: the picker's groups are built from listAccessibleDrives, so an org
 * member who has not joined a RESTRICTED drive (or is not invited to a PRIVATE one) never sees it,
 * while the Open drive and their own drive are grouped under the org header and Personal.
 * Deletes every row it creates (drives, org, users last) and ends the pool.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { listAccessibleDrives } from '../../services/drive-service';
import { groupPickerDrives } from '../drive-picker-groups';

vi.mock('../orgs-enabled', () => ({ ORGS_ENABLED: true }));

let ready = false;
let orgId = '';
const userIds: string[] = [];
let tomasId = '';

beforeAll(async () => {
  try {
    await db.select({ id: drives.id }).from(drives).limit(1);
    ready = true;
  } catch (error) {
    requireDb('drive-picker-groups.integration.test.ts', error);
    return;
  }
  const lead = await factories.createUser({ name: 'Priya Nair' });
  const tomas = await factories.createUser({ name: 'Tomás Alvarez' });
  userIds.push(lead.id, tomas.id);
  tomasId = tomas.id;
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: lead.id }).returning();
  orgId = org.id;
  await factories.createOrgSubscription(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: lead.id, role: 'OWNER' },
    { orgId: org.id, userId: tomas.id, role: 'MEMBER' },
  ]);
  await factories.createDrive(lead.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDrive(lead.id, { name: 'Finance', slug: `finance-${createId()}`, orgId: org.id, orgVisibility: 'RESTRICTED' });
  await factories.createDrive(lead.id, { name: 'Board', slug: `board-${createId()}`, orgId: org.id, orgVisibility: 'PRIVATE' });
  await factories.createDrive(tomas.id, { name: 'Side project', slug: `side-${createId()}` });
});

afterAll(async () => {
  if (ready) {
    await db.delete(drives).where(inArray(drives.ownerId, userIds));
    if (orgId) {
      await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
    }
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await pool.end();
});

describe('the drive picker over the real accessible-drives list', () => {
  it('DRV-9 (partial) an org member sees the Open drive under the org and their own under Personal; an un-joined RESTRICTED and an uninvited PRIVATE drive appear nowhere', async () => {
    if (!ready) return;
    const accessible = await listAccessibleDrives(tomasId);
    const groups = groupPickerDrives(accessible, [{ id: orgId, name: 'Northwind Labs', avatarUrl: null, role: 'MEMBER' }]);
    expect(groups.map((g) => [g.label, g.drives.map((d) => d.name)])).toEqual([
      ['Northwind Labs', ['Product']],
      ['Personal', expect.arrayContaining(['Side project'])],
    ]);
    const names = groups.flatMap((g) => g.drives.map((d) => d.name));
    expect(names).not.toContain('Finance');
    expect(names).not.toContain('Board');
  });
});

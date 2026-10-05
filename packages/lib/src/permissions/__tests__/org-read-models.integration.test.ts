/**
 * Org read models against a real Postgres (D-OW-38; UI-7). Northwind: Jono owns the org and leads
 * Product (Open) and Finance (Private); Priya is an Admin; Marcus a Member materialized onto
 * Product; Chris Rowe an invited outsider on Product (a guest); Pia a pending outsider invite on
 * Finance; Lou left the org but his materialized row on Product remains (stale, counts nowhere).
 * Product holds two files (3,000 bytes). A trashed org drive is ignored.
 *
 * Requires DATABASE_URL; deletes every row it creates, users last, and ends the pool.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { sessions } from '@pagespace/db/schema/sessions';
import { files } from '@pagespace/db/schema/storage';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { listOrgDriveUsage, listOrgGuests, listOrgMemberActivity, listOrgTrashedDrives } from '../org-read-models';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

// Reachability is settled before collection, so a DB-less run skips the suite (requireDb throws unless opted out).
const ok = await db.select({ id: users.id }).from(users).limit(1).then(
  () => true,
  (error: unknown) => {
    requireDb('org-read-models.integration.test.ts', error);
    return false;
  },
);
const ids = { users: [] as string[], orgId: '', drives: [] as string[], files: [] as string[], sessions: [] as string[] };
const u = { jono: '', priya: '', marcus: '', chris: '', pia: '', lou: '', gail: '' };
const d = { product: '', finance: '', trashed: '', archive: '' };
const archivedAt = new Date('2026-09-20T12:00:00Z');
const marcusSeen = new Date('2026-10-04T09:30:00Z');

describe.skipIf(!ok)('org read models (real Postgres)', () => {
  beforeAll(async () => {
    const make = (name: string, email: string) => factories.createUser({ name, email });
    const [jono, priya, marcus, chris, pia, lou, gail] = await Promise.all([
      make('Jono Woodall', `jono-${createId()}@northwind.test`),
      make('Priya Nair', `priya-${createId()}@northwind.test`),
      make('Marcus Oyelaran', `marcus-${createId()}@northwind.test`),
      make('Chris Rowe', `chris-${createId()}@partner.test`),
      make('Pia Pending', `pia-${createId()}@partner.test`),
      make('Lou Left', `lou-${createId()}@northwind.test`),
      make('Gail Link', `gail-${createId()}@partner.test`),
    ]);
    Object.assign(u, { jono: jono.id, priya: priya.id, marcus: marcus.id, chris: chris.id, pia: pia.id, lou: lou.id, gail: gail.id });
    ids.users = Object.values(u);
    const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `nw-${createId()}`, ownerId: jono.id }).returning();
    ids.orgId = org.id;
    await db.insert(orgMembers).values([
      { orgId: org.id, userId: jono.id, role: 'OWNER' },
      { orgId: org.id, userId: priya.id, role: 'ADMIN' },
      { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
    ]);
    const product = await factories.createDrive(jono.id, { name: 'Product', slug: `p-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
    const finance = await factories.createDrive(jono.id, { name: 'Finance', slug: `f-${createId()}`, orgId: org.id, orgVisibility: 'PRIVATE' });
    const trashed = await factories.createDrive(jono.id, { name: 'Old', slug: `o-${createId()}`, orgId: org.id, isTrashed: true });
    const archive = await factories.createDrive(priya.id, { name: 'Archive', slug: `a-${createId()}`, orgId: org.id, isTrashed: true, trashedAt: archivedAt });
    Object.assign(d, { product: product.id, finance: finance.id, trashed: trashed.id, archive: archive.id });
    ids.drives = Object.values(d);
    await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
    await factories.createDriveMember(product.id, chris.id, { source: 'invite' });
    await factories.createDriveMember(product.id, lou.id, { source: 'org' });
    await factories.createDriveMember(finance.id, pia.id, { source: 'invite', acceptedAt: null });
    // Marcus is invited to Finance but has not accepted; Gail redeemed a page share link on Product (a GUEST row).
    await factories.createDriveMember(finance.id, marcus.id, { source: 'invite', acceptedAt: null });
    await factories.createDriveMember(product.id, gail.id, { source: 'invite', role: 'GUEST' });
    await factories.createDriveMember(trashed.id, chris.id, { source: 'invite' });
    ids.files = [createId(), createId(), createId()];
    await db.insert(files).values([
      { id: ids.files[0], driveId: product.id, sizeBytes: 1000 },
      { id: ids.files[1], driveId: product.id, sizeBytes: 2000 },
      { id: ids.files[2], driveId: trashed.id, sizeBytes: 9999 },
    ]);
    const [s1] = await db.insert(sessions).values({ tokenHash: createId(), tokenPrefix: 'ps_', userId: marcus.id, type: 'user', scopes: [], tokenVersion: 0, expiresAt: new Date('2027-01-01'), lastUsedAt: marcusSeen }).returning();
    const [s2] = await db.insert(sessions).values({ tokenHash: createId(), tokenPrefix: 'ps_', userId: marcus.id, type: 'user', scopes: [], tokenVersion: 0, expiresAt: new Date('2027-01-01'), lastUsedAt: new Date('2026-09-01T00:00:00Z') }).returning();
    const [s3] = await db.insert(sessions).values({ tokenHash: createId(), tokenPrefix: 'ps_', userId: priya.id, type: 'user', scopes: [], tokenVersion: 0, expiresAt: new Date('2027-01-01'), lastUsedAt: new Date('2026-10-05T00:00:00Z'), revokedAt: new Date() }).returning();
    ids.sessions = [s1.id, s2.id, s3.id];
  });

  afterAll(async () => {
    await db.delete(sessions).where(inArray(sessions.id, ids.sessions));
    await db.delete(files).where(inArray(files.id, ids.files));
    await db.delete(driveMembers).where(inArray(driveMembers.driveId, ids.drives));
    await db.delete(drives).where(inArray(drives.id, ids.drives));
    await db.delete(orgMembers).where(eq(orgMembers.orgId, ids.orgId));
    await db.delete(organizations).where(eq(organizations.id, ids.orgId));
    await db.delete(users).where(inArray(users.id, ids.users));
    await pool.end();
  });

  it('UI-7 (partial) DRV-8 (partial): guests are the outsiders in live org drives, with each drive; stale rows and org members never appear', async () => {
    const guests = await listOrgGuests(ids.orgId);
    expect(guests.map((g) => ({ userId: g.userId, name: g.name, drives: g.drives }))).toEqual([
      { userId: u.chris, name: 'Chris Rowe', drives: [{ id: d.product, name: 'Product', pending: false }] },
      { userId: u.pia, name: 'Pia Pending', drives: [{ id: d.finance, name: 'Finance', pending: true }] },
    ]);
    expect(guests[0].email).toMatch(/^chris-.*@partner\.test$/);
  });

  it('UI-7 (partial): per live drive, accepted people, guests among them, and stored bytes', async () => {
    const usage = await listOrgDriveUsage(ids.orgId);
    expect(usage.sort((a, b) => a.driveId.localeCompare(b.driveId))).toEqual(
      [
        { driveId: d.product, memberCount: 2, guestCount: 1, storageBytes: 3000 },
        { driveId: d.finance, memberCount: 0, guestCount: 0, storageBytes: 0 },
      ].sort((a, b) => a.driveId.localeCompare(b.driveId)),
    );
  });

  it('UI-7 (partial): Owner and Admin reach every live org drive; a Member the drives they are in; last active is the latest live session', async () => {
    const activity = Object.fromEntries((await listOrgMemberActivity(ids.orgId)).map((a) => [a.userId, a]));
    expect(activity[u.jono]).toEqual({ userId: u.jono, driveCount: 2, lastActiveAt: null });
    expect(activity[u.priya]).toEqual({ userId: u.priya, driveCount: 2, lastActiveAt: null });
    expect(activity[u.marcus]).toEqual({ userId: u.marcus, driveCount: 1, lastActiveAt: marcusSeen.toISOString() });
    expect(activity[u.lou]).toBeUndefined();
  });

  it('UI-7 (partial): a pending invitee is not counted as a member, and a page-link guest is neither a member nor a listed guest', async () => {
    const usage = Object.fromEntries((await listOrgDriveUsage(ids.orgId)).map((x) => [x.driveId, x]));
    // Finance holds only pending invitations (Pia, Marcus): nobody is in it yet.
    expect(usage[d.finance]).toMatchObject({ memberCount: 0, guestCount: 0 });
    // Product: Marcus and Chris; Gail's page-link row is not a person in the drive.
    expect(usage[d.product]).toMatchObject({ memberCount: 2, guestCount: 1 });
    const activity = (await listOrgMemberActivity(ids.orgId)).find((a) => a.userId === u.marcus);
    expect(activity?.driveCount).toBe(1);
    expect((await listOrgGuests(ids.orgId)).map((g) => g.userId)).not.toContain(u.gail);
  });

  it('UI-7 (partial): trashed org drives, Private ones included, whoever the viewer is (the admin Trashed tab)', async () => {
    const trashed = await listOrgTrashedDrives(ids.orgId);
    expect(trashed.map((t) => ({ id: t.id, name: t.name, trashedAt: t.trashedAt, lead: t.lead.name }))).toEqual([
      { id: d.archive, name: 'Archive', trashedAt: archivedAt.toISOString(), lead: 'Priya Nair' },
      { id: d.trashed, name: 'Old', trashedAt: null, lead: 'Jono Woodall' },
    ]);
  });

  it('an org with no drives or members has no guests, usage, activity or trash', async () => {
    const [empty] = await db.insert(organizations).values({ name: 'Empty', slug: `e-${createId()}`, ownerId: u.jono }).returning();
    try {
      expect(await listOrgGuests(empty.id)).toEqual([]);
      expect(await listOrgDriveUsage(empty.id)).toEqual([]);
      expect(await listOrgMemberActivity(empty.id)).toEqual([]);
      expect(await listOrgTrashedDrives(empty.id)).toEqual([]);
    } finally {
      await db.delete(organizations).where(eq(organizations.id, empty.id));
    }
  });
});

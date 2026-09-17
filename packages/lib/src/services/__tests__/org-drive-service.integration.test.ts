/**
 * Org-owned drives — REAL Postgres (Spec DRV-1..DRV-4, O-7, O-10).
 *
 * The pure decisions are unit-tested in organizations/__tests__/org-drive-ownership.test.ts.
 * This file proves what only the database can: a move rewrites drives.orgId and nothing
 * else a drive carries (members, custom roles, pages, envs, publishSubdomain), the Home CHECK
 * and per-org slug index hold, and an unchosen visibility lands on the column default.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test -- src/services/__tests__/org-drive-service.integration.test.ts
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { organizations, orgMembers, type OrgRole } from '@pagespace/db/schema/organizations';
import {
  moveDriveToOrg,
  moveDriveOutOfOrg,
  createOrgDrive,
  type OrgDriveServiceDeps,
  type OrgMembershipSyncCall,
} from '../org-drive-service';
import { STORAGE_REATTRIBUTION_LEAF_ID } from '../../organizations/org-drive-ownership';

// Northwind Labs fixture names (Sequence Spec Part 2), with per-run ids.
const run = createId().slice(0, 8);
const jono = createId();
const priya = createId();
const marcus = createId();
const lena = createId();
const chris = createId();
const northwind = createId();
const userIds = [jono, priya, marcus, lena, chris];

const syncCalls: OrgMembershipSyncCall[] = [];

const deps: OrgDriveServiceDeps = {
  // Test double for the org role lookup; production wires the org repository.
  getOrgRole: async (tx, orgId, userId) => {
    const [row] = await tx
      .select({ role: orgMembers.role })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    return (row?.role ?? null) as OrgRole | null;
  },
  syncOrgMembership: async (_tx, call) => {
    syncCalls.push(call);
  },
  getOrgDriveCreationPolicy: async () => 'members',
};

async function seedPersonalDrive(over: { ownerId?: string; kind?: 'STANDARD' | 'HOME'; slug?: string; name?: string } = {}) {
  const id = createId();
  await db.insert(drives).values({
    id,
    name: over.name ?? 'Product',
    slug: over.slug ?? `product-${run}-${id.slice(0, 6)}`,
    ownerId: over.ownerId ?? marcus,
    kind: over.kind ?? 'STANDARD',
    publishSubdomain: `product-${id}`,
    updatedAt: new Date(),
  });
  return id;
}

async function readDrive(id: string) {
  const [row] = await db.select().from(drives).where(eq(drives.id, id));
  return row;
}

beforeEach(async () => {
  syncCalls.length = 0;
  await db.delete(drives).where(inArray(drives.ownerId, userIds));
  await db.delete(organizations).where(eq(organizations.id, northwind));
  await db.delete(users).where(inArray(users.id, userIds));

  await db.insert(users).values([
    { id: jono, email: `jono-${run}@northwind.test`, name: 'Jono', updatedAt: new Date() },
    { id: priya, email: `priya-${run}@northwind.test`, name: 'Priya Nair', updatedAt: new Date() },
    { id: marcus, email: `marcus-${run}@northwind.test`, name: 'Marcus Oyelaran', updatedAt: new Date() },
    { id: lena, email: `lena-${run}@northwind.test`, name: 'Lena Schulz', updatedAt: new Date() },
    { id: chris, email: `chris-${run}@outside.test`, name: 'Chris Rowe', updatedAt: new Date() },
  ]);
  await db.insert(organizations).values({ id: northwind, name: 'Northwind Labs', slug: `northwind-${run}`, ownerId: jono });
  await db.insert(orgMembers).values([
    { orgId: northwind, userId: jono, role: 'OWNER' },
    { orgId: northwind, userId: priya, role: 'ADMIN' },
    { orgId: northwind, userId: marcus, role: 'MEMBER' },
    { orgId: northwind, userId: lena, role: 'MEMBER' },
  ]);
});

afterAll(async () => {
  await db.delete(drives).where(inArray(drives.ownerId, userIds));
  await db.delete(organizations).where(eq(organizations.id, northwind));
  await db.delete(users).where(inArray(users.id, userIds));
});

describe('moveDriveToOrg', () => {
  it('DRV-2 (partial) moving a drive in keeps its members, roles, pages, envs and publishSubdomain', async () => {
    const driveId = await seedPersonalDrive();
    const [role] = await db.insert(driveRoles).values({ driveId, name: 'Editors', permissions: {} }).returning();
    await db.insert(driveMembers).values([
      { driveId, userId: lena, role: 'ADMIN', customRoleId: role.id, acceptedAt: new Date() },
      { driveId, userId: chris, role: 'MEMBER', acceptedAt: new Date() },
    ]);
    await db.insert(pages).values({ driveId, title: 'Roadmap', type: 'DOCUMENT', position: 1, updatedAt: new Date() });
    await db.insert(driveEnvs).values({ driveId, name: 'prod', createdBy: marcus, updatedAt: new Date() });
    const before = await readDrive(driveId);

    const result = await moveDriveToOrg(marcus, driveId, { orgId: northwind }, deps);

    expect(result).toMatchObject({
      ok: true,
      storageReattribution: { status: 'deferred', leafId: STORAGE_REATTRIBUTION_LEAF_ID },
    });
    const after = await readDrive(driveId);
    expect(after.orgId).toBe(northwind);
    expect(after.ownerId).toBe(marcus);
    expect(after.publishSubdomain).toBe(before.publishSubdomain);
    expect(after.slug).toBe(before.slug);
    const members = await db.select().from(driveMembers).where(eq(driveMembers.driveId, driveId));
    expect(members.map((m) => [m.userId, m.role, m.customRoleId, m.source]).sort()).toEqual(
      [[lena, 'ADMIN', role.id, 'invite'], [chris, 'MEMBER', null, 'invite']].sort()
    );
    expect(await db.select().from(pages).where(eq(pages.driveId, driveId))).toHaveLength(1);
    expect(await db.select().from(driveEnvs).where(eq(driveEnvs.driveId, driveId))).toHaveLength(1);
    expect(syncCalls).toEqual([{ kind: 'move-in', driveId, orgId: northwind }]);
  });

  it('DRV-1 (partial) a Home drive is refused and nothing is written', async () => {
    const driveId = await seedPersonalDrive({ kind: 'HOME', name: 'Home' });

    const result = await moveDriveToOrg(marcus, driveId, { orgId: northwind }, deps);

    expect(result).toMatchObject({ ok: false, code: 'HOME_DRIVE', status: 403 });
    expect((await readDrive(driveId)).orgId).toBeNull();
    expect(syncCalls).toEqual([]);
  });

  it('DRV-2 (partial) an org Admin cannot move in a drive they do not own', async () => {
    const driveId = await seedPersonalDrive();

    const result = await moveDriveToOrg(priya, driveId, { orgId: northwind }, deps);

    expect(result).toMatchObject({ ok: false, code: 'NOT_DRIVE_OWNER' });
    expect((await readDrive(driveId)).orgId).toBeNull();
  });

  it('O-7 (partial) a drive owner outside the org cannot move their drive in', async () => {
    const driveId = await seedPersonalDrive({ ownerId: chris });

    const result = await moveDriveToOrg(chris, driveId, { orgId: northwind }, deps);

    expect(result).toMatchObject({ ok: false, code: 'NOT_ORG_MEMBER' });
    expect((await readDrive(driveId)).orgId).toBeNull();
  });

  it('DRV-2 (partial) a missing drive answers not found', async () => {
    expect(await moveDriveToOrg(marcus, createId(), { orgId: northwind }, deps)).toMatchObject({
      ok: false,
      code: 'DRIVE_NOT_FOUND',
      status: 404,
    });
  });

  it('DRV-4 (partial) a drive moved in without a chosen visibility is Open, even if it was Private in an earlier stint', async () => {
    const driveId = await seedPersonalDrive();
    await db.update(drives).set({ orgVisibility: 'PRIVATE' }).where(eq(drives.id, driveId));

    await moveDriveToOrg(marcus, driveId, { orgId: northwind }, deps);

    expect((await readDrive(driveId)).orgVisibility).toBe('OPEN');
  });

  it('DRV-4 (partial) a drive moved in with a chosen visibility keeps the choice', async () => {
    const driveId = await seedPersonalDrive();

    await moveDriveToOrg(marcus, driveId, { orgId: northwind, orgVisibility: 'RESTRICTED' }, deps);

    expect((await readDrive(driveId)).orgVisibility).toBe('RESTRICTED');
  });

  it('DRV-2 (partial) a slug already taken inside the org gets the next free suffix on move-in', async () => {
    const slug = `product-${run}`;
    const takenId = await seedPersonalDrive({ ownerId: lena, slug });
    await moveDriveToOrg(lena, takenId, { orgId: northwind }, deps);
    const driveId = await seedPersonalDrive({ slug });

    const result = await moveDriveToOrg(marcus, driveId, { orgId: northwind }, deps);

    expect(result).toMatchObject({ ok: true });
    expect((await readDrive(driveId)).slug).toBe(`${slug}-2`);
  });
});

describe('moveDriveOutOfOrg', () => {
  async function seedOrgDrive() {
    const driveId = await seedPersonalDrive();
    await moveDriveToOrg(marcus, driveId, { orgId: northwind }, deps);
    syncCalls.length = 0;
    return driveId;
  }

  it('DRV-2 (partial) an org Admin moves a drive out: it becomes its lead\'s personal drive with members, pages and publishSubdomain intact', async () => {
    const driveId = await seedOrgDrive();
    await db.insert(driveMembers).values({ driveId, userId: chris, role: 'MEMBER', acceptedAt: new Date() });
    await db.insert(pages).values({ driveId, title: 'Roadmap', type: 'DOCUMENT', position: 1, updatedAt: new Date() });
    const before = await readDrive(driveId);

    const result = await moveDriveOutOfOrg(priya, driveId, { implicitMembers: 'keep' }, deps);

    expect(result).toMatchObject({
      ok: true,
      storageReattribution: { status: 'deferred', leafId: STORAGE_REATTRIBUTION_LEAF_ID },
    });
    const after = await readDrive(driveId);
    expect(after.orgId).toBeNull();
    expect(after.ownerId).toBe(marcus);
    expect(after.publishSubdomain).toBe(before.publishSubdomain);
    expect(await db.select().from(driveMembers).where(eq(driveMembers.driveId, driveId))).toHaveLength(1);
    expect(await db.select().from(pages).where(eq(pages.driveId, driveId))).toHaveLength(1);
  });

  it.each(['keep', 'remove'] as const)(
    'O-10 (partial) move-out hands the "%s" choice to membership sync inside the move',
    async (implicitMembers) => {
      const driveId = await seedOrgDrive();

      await moveDriveOutOfOrg(jono, driveId, { implicitMembers }, deps);

      expect(syncCalls).toEqual([{ kind: 'move-out', driveId, orgId: northwind, implicitMembers }]);
    }
  );

  it('DRV-2 (partial) the lead who is only an org Member cannot move the drive out', async () => {
    const driveId = await seedOrgDrive();

    const result = await moveDriveOutOfOrg(marcus, driveId, { implicitMembers: 'remove' }, deps);

    expect(result).toMatchObject({ ok: false, code: 'NOT_ORG_ADMIN' });
    expect((await readDrive(driveId)).orgId).toBe(northwind);
    expect(syncCalls).toEqual([]);
  });

  it('DRV-2 (partial) a failing membership sync rolls the move back', async () => {
    const driveId = await seedOrgDrive();
    const failing: OrgDriveServiceDeps = {
      ...deps,
      syncOrgMembership: async () => {
        throw new Error('sync failed');
      },
    };

    await expect(moveDriveOutOfOrg(priya, driveId, { implicitMembers: 'keep' }, failing)).rejects.toThrow('sync failed');
    expect((await readDrive(driveId)).orgId).toBe(northwind);
  });
});

describe('createOrgDrive', () => {
  it('DRV-4 a drive created in an org without a chosen visibility is Open', async () => {
    const result = await createOrgDrive(marcus, { name: 'Engineering', orgId: northwind }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await readDrive(result.drive.id);
    expect(row.orgId).toBe(northwind);
    expect(row.orgVisibility).toBe('OPEN');
    expect(row.ownerId).toBe(marcus);
    expect(row.publishSubdomain).not.toBeNull();
    expect(syncCalls).toEqual([{ kind: 'create', driveId: result.drive.id, orgId: northwind }]);
  });

  it('DRV-3 (partial) a drive created in an org keeps a chosen visibility', async () => {
    const result = await createOrgDrive(priya, { name: 'Finance', orgId: northwind, orgVisibility: 'PRIVATE' }, deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await readDrive(result.drive.id)).orgVisibility).toBe('PRIVATE');
  });

  it('DRV-3 (partial) a user outside the org cannot create a drive in it, and nothing is inserted', async () => {
    const result = await createOrgDrive(chris, { name: `Sneaky ${run}`, orgId: northwind }, deps);

    expect(result).toMatchObject({ ok: false, code: 'NOT_ORG_MEMBER' });
    expect(await db.select().from(drives).where(eq(drives.ownerId, chris))).toEqual([]);
  });

  it('DRV-3 (partial) the creation policy seam is consulted: admins-only refuses a Member', async () => {
    const adminsOnly: OrgDriveServiceDeps = { ...deps, getOrgDriveCreationPolicy: async () => 'admins' };

    expect(await createOrgDrive(marcus, { name: 'Engineering', orgId: northwind }, adminsOnly)).toMatchObject({
      ok: false,
      code: 'POLICY_FORBIDS_CREATE',
    });
  });

  it('DRV-3 (partial) two org drives with the same name get distinct slugs in the org', async () => {
    const first = await createOrgDrive(marcus, { name: `Design System ${run}`, orgId: northwind }, deps);
    const second = await createOrgDrive(lena, { name: `Design System ${run}`, orgId: northwind }, deps);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.drive.slug).toBe(`${first.drive.slug}-2`);
  });
});

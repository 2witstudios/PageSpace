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

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray, or } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { organizations, orgMembers, orgInvitations, type OrgRole } from '@pagespace/db/schema/organizations';
import {
  moveDriveToOrg,
  moveDriveOutOfOrg,
  createOrgDrive,
  type OrgDriveServiceDeps,
  type OrgMembershipSyncCall,
} from '../org-drive-service';
import { STORAGE_REATTRIBUTION_LEAF_ID } from '../../organizations/org-drive-ownership';
import { orgDriveServiceDeps } from '../org-drive-service-deps';
import { accountRepository } from '../../repositories/account-repository';

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
/** Records the order of commit-visible effects: a publish must run after the move committed. */
const published: Array<{ call: OrgMembershipSyncCall; orgIdAtPublish: string | null }> = [];

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
    return async () => {
      // Read through the root pool, outside the move's transaction: only committed state is visible.
      const [row] = await db.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, call.driveId));
      published.push({ call, orgIdAtPublish: row?.orgId ?? null });
    };
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

/**
 * organizations.ownerId and drives.orgId are ON DELETE RESTRICT, and CI shares one database
 * across suites: leftovers here would make a later suite's user cleanup fail. Delete in
 * dependency order — org drives (and this run's personal drives), invitations, members, the
 * org — before any user.
 */
async function cleanup() {
  await db.delete(drives).where(or(eq(drives.orgId, northwind), inArray(drives.ownerId, userIds)));
  await db.delete(orgInvitations).where(eq(orgInvitations.orgId, northwind));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, northwind));
  await db.delete(organizations).where(eq(organizations.id, northwind));
  await db.delete(users).where(inArray(users.id, userIds));
}

beforeEach(async () => {
  syncCalls.length = 0;
  published.length = 0;
  await cleanup();

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

afterEach(cleanup);

afterAll(async () => {
  await cleanup();
  await pool.end();
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
      orgId: northwind,
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
    expect(published).toEqual([{ call: syncCalls[0], orgIdAtPublish: northwind }]);
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

  it('D-OW-7 a drive owner outside the org cannot move their drive in', async () => {
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
    published.length = 0;
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
      orgId: northwind,
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
    'D-OW-10 move-out hands the "%s" choice to membership sync inside the move',
    async (implicitMembers) => {
      const driveId = await seedOrgDrive();

      await moveDriveOutOfOrg(jono, driveId, { implicitMembers }, deps);

      expect(syncCalls).toEqual([{ kind: 'move-out', driveId, orgId: northwind, implicitMembers }]);
      expect(published).toEqual([{ call: syncCalls[0], orgIdAtPublish: null }]);
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
    expect(published).toEqual([]);
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
    expect(published).toEqual([{ call: syncCalls[0], orgIdAtPublish: northwind }]);
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

  it('DRV-3 (partial) concurrent creates of the same name in one org all succeed with distinct slugs', async () => {
    const name = `Marketing Site ${run}`;
    const results = await Promise.all([
      createOrgDrive(marcus, { name, orgId: northwind }, deps),
      createOrgDrive(lena, { name, orgId: northwind }, deps),
      createOrgDrive(priya, { name, orgId: northwind }, deps),
    ]);

    const slugs = results.map((r) => (r.ok ? r.drive.slug : r.code)).sort();
    const base = slugs[0];
    expect(slugs).toEqual([base, `${base}-2`, `${base}-3`]);
  });
});

describe('with the production wiring (requireOrgRole, syncDriveOrgMembership, deleteUser)', () => {
  // The sync publishes realtime events and room kicks after commit. This file asserts rows, not
  // events (the sync's own suite covers those), so no realtime server is reached: with the URL
  // unset both publishers return early instead of waiting on whatever listens on the default port.
  const realtimeUrl = process.env.INTERNAL_REALTIME_URL;
  beforeAll(() => {
    delete process.env.INTERNAL_REALTIME_URL;
  });
  afterAll(() => {
    process.env.INTERNAL_REALTIME_URL = realtimeUrl;
  });

  async function productInNorthwind() {
    const driveId = await seedPersonalDrive();
    // Chris Rowe is a guest: an invited member who is not in the org (DRV-8).
    await db.insert(driveMembers).values({ driveId, userId: chris, role: 'MEMBER', acceptedAt: new Date() });
    const moved = await moveDriveToOrg(marcus, driveId, { orgId: northwind }, orgDriveServiceDeps);
    expect(moved).toMatchObject({ ok: true });
    return driveId;
  }

  const rowsOf = async (driveId: string) =>
    (await db.select().from(driveMembers).where(eq(driveMembers.driveId, driveId)))
      .map((m) => [m.userId, m.source])
      .sort();

  it('D-OW-10 moving out with "keep" leaves org members on the drive as invited members, guest untouched', async () => {
    const driveId = await productInNorthwind();
    expect(await rowsOf(driveId)).toContainEqual([lena, 'org']);

    const result = await moveDriveOutOfOrg(priya, driveId, { implicitMembers: 'keep' }, orgDriveServiceDeps);

    expect(result).toMatchObject({ ok: true });
    const rows = await rowsOf(driveId);
    expect(rows).toContainEqual([lena, 'invite']);
    expect(rows).toContainEqual([chris, 'invite']);
    expect(rows.filter(([, source]) => source === 'org')).toEqual([]);
  });

  it('D-OW-10 moving out with "remove" revokes the org members and keeps the guest', async () => {
    const driveId = await productInNorthwind();

    const result = await moveDriveOutOfOrg(jono, driveId, { implicitMembers: 'remove' }, orgDriveServiceDeps);

    expect(result).toMatchObject({ ok: true });
    expect(await rowsOf(driveId)).toEqual([[chris, 'invite']]);
  });

  it('D-OW-7 deleting the lead\'s account does not cascade the org drive: the org Owner becomes its lead', async () => {
    const driveId = await productInNorthwind();

    await accountRepository.deleteUser(marcus);

    const after = await readDrive(driveId);
    expect(after).toBeDefined();
    expect(after.orgId).toBe(northwind);
    expect(after.ownerId).toBe(jono);
    expect(await db.select().from(pages).where(eq(pages.driveId, driveId))).toEqual([]);
  });
});

describe('with the production wiring: authorization', () => {
  const realtimeUrl = process.env.INTERNAL_REALTIME_URL;
  beforeAll(() => {
    delete process.env.INTERNAL_REALTIME_URL;
  });
  afterAll(() => {
    process.env.INTERNAL_REALTIME_URL = realtimeUrl;
  });

  it('D-OW-7 a drive owner outside the org cannot move their drive in (real requireOrgRole)', async () => {
    const driveId = await seedPersonalDrive({ ownerId: chris });

    const result = await moveDriveToOrg(chris, driveId, { orgId: northwind }, orgDriveServiceDeps);

    expect(result).toMatchObject({ ok: false, code: 'NOT_ORG_MEMBER' });
    expect((await readDrive(driveId)).orgId).toBeNull();
  });

  it('DRV-3 (partial) a user outside the org cannot create a drive in it, and nothing is inserted (real requireOrgRole)', async () => {
    const result = await createOrgDrive(chris, { name: `Outsider ${run}`, orgId: northwind }, orgDriveServiceDeps);

    expect(result).toMatchObject({ ok: false, code: 'NOT_ORG_MEMBER' });
    expect(await db.select().from(drives).where(eq(drives.orgId, northwind))).toEqual([]);
  });

  it('DRV-2 (partial) an org Member cannot move a drive out, even when they lead it (real requireOrgRole)', async () => {
    const driveId = await seedPersonalDrive();
    expect(await moveDriveToOrg(marcus, driveId, { orgId: northwind }, orgDriveServiceDeps)).toMatchObject({ ok: true });

    const result = await moveDriveOutOfOrg(marcus, driveId, { implicitMembers: 'remove' }, orgDriveServiceDeps);

    expect(result).toMatchObject({ ok: false, code: 'NOT_ORG_ADMIN' });
    expect((await readDrive(driveId)).orgId).toBe(northwind);
  });

  /**
   * The race from review 5235664932 (P1 #1). Session B is account deletion for the lead, as
   * accountRepository.deleteUser runs it: leave the org (delete the org_members row), reassign
   * the org drives the user leads (none yet: the drive is still personal), delete the user.
   * B holds its membership delete uncommitted while the move or create starts. If the service
   * read the role outside its own transaction it would see MEMBER, commit an org drive led by
   * the user, and B's users cascade would then hard-delete that org drive.
   */
  it.each(['move-in', 'create'] as const)(
    'D-OW-7 a %s overlapping the lead\'s account deletion never leaves a committed org drive deleted',
    async (operation) => {
      const personalId = operation === 'move-in' ? await seedPersonalDrive() : null;
      const b = await pool.connect();
      try {
        await b.query('BEGIN');
        await b.query('DELETE FROM org_members WHERE "orgId" = $1 AND "userId" = $2', [northwind, marcus]);
        const led = await b.query(
          'SELECT d.id FROM drives d JOIN organizations o ON d."orgId" = o.id WHERE d."ownerId" = $1 FOR UPDATE',
          [marcus]
        );
        expect(led.rows).toEqual([]);

        const pending = (
          operation === 'move-in' && personalId
            ? moveDriveToOrg(marcus, personalId, { orgId: northwind }, orgDriveServiceDeps)
            : createOrgDrive(marcus, { name: `Race ${run}`, orgId: northwind }, orgDriveServiceDeps)
        ).then(
          (result) => ({ result }),
          (error: unknown) => ({ error })
        );
        await new Promise((resolve) => setTimeout(resolve, 400));

        try {
          await b.query('DELETE FROM users WHERE id = $1', [marcus]);
          await b.query('COMMIT');
        } catch {
          // Postgres may pick B as the deadlock victim; that fails closed.
          await b.query('ROLLBACK');
        }

        const outcome = await pending;
        const committedDriveId =
          'result' in outcome && outcome.result.ok ? outcome.result.drive.id : null;
        if (committedDriveId !== null) {
          const [row] = await db.select().from(drives).where(eq(drives.id, committedDriveId));
          expect(row).toBeDefined();
          expect(row.orgId).toBe(northwind);
        }
      } finally {
        b.release();
      }
    }
  );
});

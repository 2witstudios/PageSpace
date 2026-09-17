/**
 * Integration tests for the org membership sync (D-OW-6).
 *
 * Requires a running Postgres database with the latest migrations applied.
 * Run via:
 *   bun run --filter '@pagespace/lib' test:integration -- src/services/__tests__/org-membership-sync.integration.test.ts
 */
import { describe, it, expect } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db } from '@pagespace/db/db';
import { and, eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles } from '@pagespace/db/schema/members';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import {
  syncDriveOrgMembership,
  syncOrgMemberAccess,
  syncOrgMembership,
  publishOrgMembershipSyncEvents,
  type OrgMembershipSyncPorts,
} from '../org-membership-sync';
import type { AffectedUser } from '../org-membership-sync-core';

function recordingPorts() {
  const broadcasts: AffectedUser[] = [];
  const kicks: Array<{ userId: string; driveId: string }> = [];
  const ports: OrgMembershipSyncPorts = {
    broadcast: async (user) => {
      broadcasts.push(user);
    },
    kick: async (target) => {
      kicks.push(target);
    },
  };
  return { ports, broadcasts, kicks };
}

async function rowsOf(driveId: string) {
  const rows = await db
    .select({ userId: driveMembers.userId, source: driveMembers.source, role: driveMembers.role, customRoleId: driveMembers.customRoleId, acceptedAt: driveMembers.acceptedAt })
    .from(driveMembers)
    .where(eq(driveMembers.driveId, driveId));
  return rows.sort((a, b) => a.userId.localeCompare(b.userId));
}

async function northwind() {
  const jono = await factories.createUser({ name: 'Jono' });
  const priya = await factories.createUser({ name: 'Priya Nair' });
  const marcus = await factories.createUser({ name: 'Marcus Oyelaran' });
  const chris = await factories.createUser({ name: 'Chris Rowe' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${jono.id}`, ownerId: jono.id }).returning();
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: priya.id, role: 'ADMIN' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(jono.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  const finance = await factories.createDrive(jono.id, { name: 'Finance', slug: `finance-${createId()}`, orgId: org.id, orgVisibility: 'PRIVATE' });
  // Chris is a guest on Product: invited directly, not in the org (DRV-8).
  await factories.createDriveMember(product.id, chris.id, { source: 'invite' });
  return { jono, priya, marcus, chris, org, product, finance };
}

describe('org membership sync (integration)', () => {
  // No global deletes: users and drives are shared across suites in CI, so every fixture is
  // unique by construction and every assertion is scoped to the drives and org it created.

  it('DRV-5 (partial) materializes accepted org rows with the drive default role for every member of an Open drive, and is idempotent when called twice', async () => {
    const { jono, priya, marcus, chris, org, product, finance } = await northwind();
    const [defaultRole] = await db
      .insert(driveRoles)
      .values({ driveId: product.id, name: 'Contributor', isDefault: true, permissions: {} })
      .returning();
    const { ports, broadcasts } = recordingPorts();

    const first = await syncOrgMembership(org.id, { ports });
    const afterFirst = await rowsOf(product.id);
    const second = await syncOrgMembership(org.id, { ports });

    expect(afterFirst).toEqual(await rowsOf(product.id));
    expect(afterFirst.map((r) => [r.userId, r.source])).toEqual(
      [[priya.id, 'org'], [marcus.id, 'org'], [chris.id, 'invite']].sort((a, b) => a[0].localeCompare(b[0])),
    );
    const orgRows = afterFirst.filter((r) => r.source === 'org');
    expect(orgRows.every((r) => r.role === 'MEMBER' && r.customRoleId === defaultRole.id && r.acceptedAt !== null)).toBe(true);
    expect(afterFirst.some((r) => r.userId === jono.id)).toBe(false);
    expect(await rowsOf(finance.id)).toEqual([]);

    expect(first.affectedUsers.map((u) => u.userId).sort()).toEqual([priya.id, marcus.id].sort());
    expect(second.affectedUsers).toEqual([]);
    expect(broadcasts.map((b) => b.userId).sort()).toEqual([priya.id, marcus.id].sort());
  });

  it('DRV-8 (partial) never touches a guest row through join, leave, visibility change and move-out', async () => {
    const { chris, priya, org, product } = await northwind();
    const { ports } = recordingPorts();
    const guestBefore = await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, product.id), eq(driveMembers.userId, chris.id)));

    await syncOrgMembership(org.id, { ports });
    await syncOrgMemberAccess(org.id, chris.id, { ports });
    await db.delete(orgMembers).where(eq(orgMembers.userId, priya.id));
    await syncOrgMemberAccess(org.id, priya.id, { ports });
    await db.update(drives).set({ orgVisibility: 'PRIVATE' }).where(eq(drives.id, product.id));
    await syncDriveOrgMembership(product.id, { ports });
    await db.update(drives).set({ orgId: null, orgVisibility: 'OPEN' }).where(eq(drives.id, product.id));
    await syncDriveOrgMembership(product.id, { ports, removedOrgRows: 'keepAsInvite' });

    const guestAfter = await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, product.id), eq(driveMembers.userId, chris.id)));
    expect(guestAfter).toEqual(guestBefore);
  });

  it('D-OW-6 adds a joining member to every Open org drive and removes a leaving member, one event per user', async () => {
    const { jono, org, product, finance } = await northwind();
    const design = await factories.createDrive(jono.id, { name: 'Design System', slug: `design-system-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
    const lena = await factories.createUser({ name: 'Lena Schulz' });
    const { ports, broadcasts, kicks } = recordingPorts();

    await db.insert(orgMembers).values({ orgId: org.id, userId: lena.id });
    const joined = await syncOrgMemberAccess(org.id, lena.id, { ports });

    expect(joined.affectedUsers).toEqual([
      { userId: lena.id, operation: 'member_added', driveIds: expect.arrayContaining([product.id, design.id]) },
    ]);
    expect((await rowsOf(product.id)).find((r) => r.userId === lena.id)?.source).toBe('org');
    expect((await rowsOf(design.id)).find((r) => r.userId === lena.id)?.source).toBe('org');
    expect((await rowsOf(finance.id)).find((r) => r.userId === lena.id)).toBeUndefined();
    // Nobody else was touched by a per-user sync.
    expect((await rowsOf(product.id)).filter((r) => r.source === 'org').map((r) => r.userId)).toEqual([lena.id]);

    await db.delete(orgMembers).where(eq(orgMembers.userId, lena.id));
    const left = await syncOrgMemberAccess(org.id, lena.id, { ports });

    expect(left.affectedUsers).toEqual([
      { userId: lena.id, operation: 'member_removed', driveIds: expect.arrayContaining([product.id, design.id]) },
    ]);
    expect((await rowsOf(product.id)).find((r) => r.userId === lena.id)).toBeUndefined();
    expect(broadcasts.filter((b) => b.userId === lena.id)).toHaveLength(2);
    expect(kicks.filter((k) => k.userId === lena.id).map((k) => k.driveId).sort()).toEqual([product.id, design.id].sort());
  });

  it('D-OW-6 removes org rows when an Open drive turns Private and restores them when it turns Open again', async () => {
    const { priya, marcus, org, product } = await northwind();
    const { ports, kicks } = recordingPorts();
    await syncOrgMembership(org.id, { ports });

    await db.update(drives).set({ orgVisibility: 'PRIVATE' }).where(eq(drives.id, product.id));
    const closed = await syncDriveOrgMembership(product.id, { ports });
    expect((await rowsOf(product.id)).filter((r) => r.source === 'org')).toEqual([]);
    expect(closed.affectedUsers.map((u) => u.operation)).toEqual(['member_removed', 'member_removed']);
    expect(kicks.map((k) => k.userId).sort()).toEqual([priya.id, marcus.id].sort());

    await db.update(drives).set({ orgVisibility: 'OPEN' }).where(eq(drives.id, product.id));
    await syncDriveOrgMembership(product.id, { ports });
    expect((await rowsOf(product.id)).filter((r) => r.source === 'org').map((r) => r.userId).sort()).toEqual([priya.id, marcus.id].sort());
  });

  it('D-OW-10 moving a drive out keeps implicit members as invited members, or removes them', async () => {
    const { jono, org, product } = await northwind();
    const research = await factories.createDrive(jono.id, { name: 'Engineering', slug: `engineering-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
    const { ports } = recordingPorts();
    await syncOrgMembership(org.id, { ports });

    await db.update(drives).set({ orgId: null }).where(eq(drives.id, product.id));
    await syncDriveOrgMembership(product.id, { ports, removedOrgRows: 'keepAsInvite' });
    expect((await rowsOf(product.id)).map((r) => r.source)).toEqual(['invite', 'invite', 'invite']);

    await db.update(drives).set({ orgId: null }).where(eq(drives.id, research.id));
    await syncDriveOrgMembership(research.id, { ports });
    expect(await rowsOf(research.id)).toEqual([]);
  });

  it('D-OW-10 keep-as-invited never makes access permanent while the drive is still in the org', async () => {
    const { priya, marcus, org, product } = await northwind();
    const { ports } = recordingPorts();
    await syncOrgMembership(org.id, { ports });

    await db.update(drives).set({ orgVisibility: 'PRIVATE' }).where(eq(drives.id, product.id));
    await syncDriveOrgMembership(product.id, { ports, removedOrgRows: 'keepAsInvite' });

    const rows = await rowsOf(product.id);
    expect(rows.some((r) => r.userId === priya.id || r.userId === marcus.id)).toBe(false);
  });

  it('DRV-5 (partial) a full sync moves org rows to a changed default role and adopts an org member\'s pending invite', async () => {
    const { priya, marcus, chris, org, product } = await northwind();
    const [oldRole] = await db.insert(driveRoles).values({ driveId: product.id, name: 'Viewer', isDefault: true, permissions: {} }).returning();
    const [editorRole] = await db.insert(driveRoles).values({ driveId: product.id, name: 'Editor', isDefault: false, permissions: {} }).returning();
    const { ports } = recordingPorts();
    await syncOrgMembership(org.id, { ports });

    // Marcus's row becomes a legacy pending invite; Chris (a guest) holds another.
    await db.update(driveMembers).set({ source: 'invite', acceptedAt: null, role: 'ADMIN', customRoleId: editorRole.id })
      .where(and(eq(driveMembers.driveId, product.id), eq(driveMembers.userId, marcus.id)));
    await db.update(driveMembers).set({ acceptedAt: null })
      .where(and(eq(driveMembers.driveId, product.id), eq(driveMembers.userId, chris.id)));
    await db.update(driveRoles).set({ isDefault: false }).where(eq(driveRoles.id, oldRole.id));
    await db.update(driveRoles).set({ isDefault: true }).where(eq(driveRoles.id, editorRole.id));

    const result = await syncOrgMembership(org.id, { ports });
    const rows = await rowsOf(product.id);

    const priyaRow = rows.find((r) => r.userId === priya.id);
    expect(priyaRow).toMatchObject({ source: 'org', customRoleId: editorRole.id });
    expect(rows.find((r) => r.userId === marcus.id)).toMatchObject({ source: 'org', role: 'MEMBER', customRoleId: editorRole.id });
    expect(rows.find((r) => r.userId === marcus.id)?.acceptedAt).not.toBeNull();
    expect(rows.find((r) => r.userId === chris.id)).toMatchObject({ source: 'invite', acceptedAt: null });
    expect(result.affectedUsers.map((u) => [u.userId, u.operation]).sort()).toEqual(
      [[priya.id, 'member_role_changed'], [marcus.id, 'member_added']].sort(),
    );

    const again = await syncOrgMembership(org.id, { ports });
    expect(again.affectedUsers).toEqual([]);
  });

  it('D-OW-6 within a caller transaction writes with the transaction and defers events to publish after commit', async () => {
    const { org, product } = await northwind();
    const { ports, broadcasts } = recordingPorts();

    const result = await db.transaction(async (tx) => {
      const r = await syncOrgMembership(org.id, { tx, ports });
      expect(broadcasts).toEqual([]);
      return r;
    });
    expect((await rowsOf(product.id)).filter((r) => r.source === 'org')).toHaveLength(2);
    expect(broadcasts).toEqual([]);

    await publishOrgMembershipSyncEvents(result, ports);
    expect(broadcasts).toHaveLength(2);
  });

  it('D-OW-6 chunks inserts past the bind-parameter limit (1,200 members)', async () => {
    const { org, product } = await northwind();
    const many = await db
      .insert(users)
      .values(Array.from({ length: 1200 }, (_, i) => {
        const id = createId();
        return { id, name: `Member ${i}`, email: `member-${id}@example.test`, provider: 'email' as const, tokenVersion: 0, role: 'user' as const, updatedAt: new Date() };
      }))
      .returning({ id: users.id });
    for (let i = 0; i < many.length; i += 500) {
      await db.insert(orgMembers).values(many.slice(i, i + 500).map((u) => ({ orgId: org.id, userId: u.id })));
    }
    const { ports } = recordingPorts();

    const result = await syncDriveOrgMembership(product.id, { ports });

    expect((await rowsOf(product.id)).filter((r) => r.source === 'org')).toHaveLength(1202);
    expect(result.affectedUsers).toHaveLength(1202);
  });
});

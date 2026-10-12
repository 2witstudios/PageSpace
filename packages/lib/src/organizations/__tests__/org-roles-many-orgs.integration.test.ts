/**
 * ORG-2 against real Postgres: the three org roles, one person holding a different one in each of several orgs, and
 * the rule that a role change moves only between Admin and Member (the Owner role moves only by transfer, ORG-1).
 * A person in no org is given nothing org-shaped to render: no org in their list and the org gate's 404 for every
 * org. That the UI then renders no org surface (picker grouping, org card, crumb, hub links, owner choice; only the
 * create-organization entry) is the web test apps/web/src/components/orgs/__tests__/no-org-ui.test.tsx.
 *
 * Run with a migrated test database:
 *   DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test \
 *   bun run --filter '@pagespace/lib' test:integration -- org-roles-many-orgs
 */
import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers, orgSubscriptions, type OrgRole } from '@pagespace/db/schema/organizations';
import { listOrganizationsForUser } from '../repository';
import { requireOrgRole } from '../authorize';
import { changeMemberRole } from '../membership';

const userIds: string[] = [];
const orgIds: string[] = [];

afterEach(async () => {
  const orgs = orgIds.splice(0);
  if (orgs.length) {
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgs));
    await db.delete(organizations).where(inArray(organizations.id, orgs));
  }
  const people = userIds.splice(0);
  if (people.length) await db.delete(users).where(inArray(users.id, people));
});

afterAll(async () => {
  await pool.end();
});

async function person(name: string) {
  const user = await factories.createUser({ name });
  userIds.push(user.id);
  return user;
}

/** A paid org (an unpaid one is lapsed and refuses promotions, D-OW-33) with the given members. */
async function org(name: string, ownerId: string, members: Array<{ userId: string; role: Exclude<OrgRole, 'OWNER'> }>) {
  const [row] = await db.insert(organizations).values({ name, slug: `${name.toLowerCase()}-${createId()}`, ownerId }).returning();
  orgIds.push(row.id);
  await db.insert(orgMembers).values([{ orgId: row.id, userId: ownerId, role: 'OWNER' }, ...members.map((m) => ({ orgId: row.id, ...m }))]);
  await factories.createOrgSubscription(row.id, { status: 'active' });
  return row;
}

describe('org roles across many orgs (real Postgres)', () => {
  it('ORG-2 one person is Owner of one org, Admin of a second and Member of a third; each org answers with its own role, a role changes only between Admin and Member, never to or from Owner; and a person in no org gets no org and the org 404 everywhere', async () => {
    const sam = await person('Sam Rivera');
    const dee = await person('Dee Walker');
    const ana = await person('Ana Lopez');
    const ben = await person('Ben Okafor');
    const harbor = await org('Harbor', sam.id, [{ userId: ana.id, role: 'ADMIN' }, { userId: ben.id, role: 'MEMBER' }]);
    const delta = await org('Delta', ana.id, [{ userId: sam.id, role: 'ADMIN' }, { userId: ben.id, role: 'MEMBER' }]);
    const comet = await org('Comet', ben.id, [{ userId: sam.id, role: 'MEMBER' }, { userId: ana.id, role: 'ADMIN' }]);

    // Many orgs, one role in each, listed and authorized per org.
    expect((await listOrganizationsForUser(sam.id)).map((o) => [o.id, o.role]))
      .toEqual([[comet.id, 'MEMBER'], [delta.id, 'ADMIN'], [harbor.id, 'OWNER']]);
    expect(await requireOrgRole(sam.id, harbor.id, 'OWNER')).toEqual({ ok: true, role: 'OWNER' });
    expect(await requireOrgRole(sam.id, delta.id, 'ADMIN')).toEqual({ ok: true, role: 'ADMIN' });
    expect(await requireOrgRole(sam.id, delta.id, 'OWNER')).toEqual({ ok: false, status: 403, reason: 'insufficient_role' });
    expect(await requireOrgRole(sam.id, comet.id, 'MEMBER')).toEqual({ ok: true, role: 'MEMBER' });
    expect(await requireOrgRole(sam.id, comet.id, 'ADMIN')).toEqual({ ok: false, status: 403, reason: 'insufficient_role' });

    // Admin <-> Member moves, and only in the org it is made in: Ben and Ana keep their roles in Delta.
    expect(await changeMemberRole({ orgId: harbor.id, actorId: sam.id, targetId: ben.id, newRole: 'ADMIN' })).toEqual({ ok: true });
    expect(await changeMemberRole({ orgId: harbor.id, actorId: sam.id, targetId: ana.id, newRole: 'MEMBER' })).toEqual({ ok: true });
    expect(await requireOrgRole(ben.id, harbor.id, 'ADMIN')).toEqual({ ok: true, role: 'ADMIN' });
    expect(await requireOrgRole(ana.id, harbor.id, 'MEMBER')).toEqual({ ok: true, role: 'MEMBER' });
    expect(await requireOrgRole(ana.id, delta.id, 'OWNER')).toEqual({ ok: true, role: 'OWNER' });
    expect(await requireOrgRole(ben.id, delta.id, 'MEMBER')).toEqual({ ok: true, role: 'MEMBER' });

    // Never to Owner, never from Owner: that is an ownership transfer.
    expect(await changeMemberRole({ orgId: harbor.id, actorId: sam.id, targetId: ben.id, newRole: 'OWNER' }))
      .toEqual({ ok: false, status: 400, reason: 'use_ownership_transfer' });
    expect(await changeMemberRole({ orgId: delta.id, actorId: sam.id, targetId: ana.id, newRole: 'MEMBER' }))
      .toEqual({ ok: false, status: 400, reason: 'use_ownership_transfer' });
    // A Member of one org changes no one's role there, whatever they are elsewhere.
    expect(await changeMemberRole({ orgId: comet.id, actorId: sam.id, targetId: ana.id, newRole: 'MEMBER' }))
      .toEqual({ ok: false, status: 403, reason: 'insufficient_role' });

    // A person in no org: nothing org-shaped to show, and every org answers as if it did not exist.
    expect(await listOrganizationsForUser(dee.id)).toEqual([]);
    for (const o of [harbor, delta, comet]) {
      expect(await requireOrgRole(dee.id, o.id, 'MEMBER')).toEqual({ ok: false, status: 404, reason: 'not_member' });
    }

    // Every org still has exactly one OWNER row, its organizations.ownerId.
    const ownerRows = await db.select({ orgId: orgMembers.orgId, userId: orgMembers.userId }).from(orgMembers)
      .where(and(inArray(orgMembers.orgId, [harbor.id, delta.id, comet.id]), eq(orgMembers.role, 'OWNER')));
    expect(ownerRows.map((r) => [r.orgId, r.userId]).sort()).toEqual([[harbor.id, sam.id], [delta.id, ana.id], [comet.id, ben.id]].sort());
  });
});

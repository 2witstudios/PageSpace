/**
 * Organizations & Wallets, Wave B3 — org services against a REAL Postgres: the
 * transactions, locks and partial unique indexes a pure test cannot see. Uses the
 * Northwind Labs fixture; slugs and emails carry a cuid because rows accumulate
 * across a CI run.
 *
 * Run with a migrated test database:
 *   DATABASE_URL=postgresql://user:password@localhost:5433/pagespace_test \
 *   bun run --filter '@pagespace/lib' test:integration -- org-services
 */
import { describe, it, expect, afterAll, afterEach, beforeAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { organizations, orgInvitations, orgMembers } from '@pagespace/db/schema/organizations';
import {
  countOrgSeats,
  createOrganization,
  listOrganizationsForUser,
} from '../repository';
import { changeMemberRole, removeMember, transferOwnership } from '../membership';
import {
  acceptInvitation,
  createOrRotateInvitation,
  listOpenInvitations,
  resendInvitation,
  revokeInvitation,
  lockOrgInviteAddress,
} from '../invitations';
import { deleteOrganization } from '../deletion';
import { requireOrgRole } from '../authorize';
import { getUserAccessLevel } from '../../permissions/permissions';
import { getDriveAccess, listAccessibleDrives, restoreDrive } from '../../services/drive-service';
import { getDriveRecipientUserIds } from '../../services/drive-member-service';
import { syncOrgMemberAccess, type OrgMembershipSyncResult } from '../../services/org-membership-sync';

// Org-derived access is dark by default; a test that proves an org-shaped negative turns it on,
// or the negative would hold only because the whole org branch is off.
const flags = vi.hoisted(() => ({ orgsEnabled: false }));
vi.mock('../orgs-enabled', () => ({
  get ORGS_ENABLED() {
    return flags.orgsEnabled;
  },
}));

const HOUR = 60 * 60 * 1000;
/** A delete that revokes rows would otherwise call the realtime service over HTTP; tests of the kick pass their own. */
const noKick = { kick: async () => {} };
/** Delivery that succeeds; tests of a failed delivery pass their own. */
const deliver = async () => {};

describe('org services (real Postgres)', () => {
  const createdUsers: string[] = [];
  const createdOrgs: string[] = [];
  const createdDrives: string[] = [];

  beforeAll(async () => {
    try {
      await db.select({ id: organizations.id }).from(organizations).limit(1);
    } catch (error) {
      requireDb('org-services.integration.test.ts', error);
    }
  });

  // Cleanup runs in dependency order and never swallows an error: organizations.ownerId and
  // drives.orgId are ON DELETE RESTRICT, so a leftover org here would make every later
  // suite's user cleanup fail in the shared CI database. Orgs are also swept by owner, so
  // one created by a service call this file did not track still goes.
  afterEach(async () => {
    flags.orgsEnabled = false;
    const driveIds = createdDrives.splice(0);
    const userIds = createdUsers.splice(0);
    const trackedOrgIds = createdOrgs.splice(0);
    const ownedOrgs = userIds.length
      ? await db.select({ id: organizations.id }).from(organizations).where(inArray(organizations.ownerId, userIds))
      : [];
    const orgIds = [...new Set([...trackedOrgIds, ...ownedOrgs.map((org) => org.id)])];

    if (driveIds.length) await db.delete(drives).where(inArray(drives.id, driveIds));
    if (orgIds.length) {
      await db.update(drives).set({ orgId: null }).where(inArray(drives.orgId, orgIds));
      // org_members and org_invitations cascade with the organization row.
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  });

  // The lib integration run shares one process across files, each with its own pool; this
  // suite holds several connections at once (lock holders, concurrent transfers), so it
  // releases them rather than leaving later suites to hit max_connections.
  afterAll(async () => {
    await pool.end();
  });

  async function person(name: string) {
    const handle = name.toLowerCase().replace(/[^a-z]/g, '');
    const user = await factories.createUser({ name, email: `${handle}-${createId()}@northwind.test` });
    createdUsers.push(user.id);
    return user;
  }

  async function seedNorthwind() {
    const jono = await person('Jono');
    const result = await createOrganization({
      name: 'Northwind Labs',
      slug: `northwind-${createId()}`,
      avatarUrl: 'https://example.test/northwind.png',
      ownerId: jono.id,
    });
    if (!result.ok) throw new Error('seed failed');
    createdOrgs.push(result.organization.id);
    return { jono, org: result.organization };
  }

  async function addMember(orgId: string, userId: string, role: 'ADMIN' | 'MEMBER') {
    await db.insert(orgMembers).values({ orgId, userId, role });
  }

  async function ownerRows(orgId: string) {
    return db
      .select({ userId: orgMembers.userId })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, 'OWNER')));
  }

  async function orgOwnerId(orgId: string) {
    const [row] = await db.select({ ownerId: organizations.ownerId }).from(organizations).where(eq(organizations.id, orgId));
    return row?.ownerId;
  }

  async function seedDrive(ownerId: string, orgId: string, values: Partial<typeof drives.$inferInsert> = {}) {
    const drive = await factories.createDrive(ownerId, { orgId, ...values });
    createdDrives.push(drive.id);
    return drive;
  }

  describe('creation and ownership', () => {
    it('ORG-1 (partial) creating an org writes ownerId and the one OWNER row together', async () => {
      const { jono, org } = await seedNorthwind();
      expect(org.name).toBe('Northwind Labs');
      expect(org.avatarUrl).toBe('https://example.test/northwind.png');
      expect(org.ownerId).toBe(jono.id);
      expect(await ownerRows(org.id)).toEqual([{ userId: jono.id }]);
      expect(await requireOrgRole(jono.id, org.id, 'OWNER')).toEqual({ ok: true, role: 'OWNER' });
    });

    it('ORG-1 (partial) a taken slug creates neither the org nor a membership row', async () => {
      const { org } = await seedNorthwind();
      const priya = await person('Priya Nair');
      const result = await createOrganization({ name: 'Copycat', slug: org.slug, ownerId: priya.id });
      expect(result).toEqual({ ok: false, reason: 'slug_taken' });
      expect(await listOrganizationsForUser(priya.id)).toEqual([]);
    });

    it('ORG-1 (partial) an AI agent can neither create an org as its Owner nor receive ownership, and nothing is written', async () => {
      const { jono, org } = await seedNorthwind();
      const product = await seedDrive(jono.id, org.id, { name: 'Product' });
      const agent = await factories.createPage(product.id, { type: 'AI_CHAT', title: 'Planner' });
      const slug = `agent-org-${createId()}`;

      expect(await createOrganization({ name: 'Agent Org', slug, ownerId: agent.id })).toEqual({ ok: false, reason: 'owner_not_human' });
      expect(await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug))).toEqual([]);
      expect(await createOrganization({ name: 'Ghost Org', slug, ownerId: createId() })).toEqual({ ok: false, reason: 'owner_not_found' });

      expect(await transferOwnership({ orgId: org.id, actorId: jono.id, targetId: agent.id })).toEqual({ ok: false, status: 400, reason: 'owner_not_human' });
      expect(await orgOwnerId(org.id)).toBe(jono.id);
      expect(await ownerRows(org.id)).toEqual([{ userId: jono.id }]);
    });

    it('ORG-1 (partial) ownership transfer moves ownerId and the OWNER row together and they never diverge', async () => {
      const { jono, org } = await seedNorthwind();
      const priya = await person('Priya Nair');
      await addMember(org.id, priya.id, 'ADMIN');

      expect(await transferOwnership({ orgId: org.id, actorId: jono.id, targetId: priya.id })).toEqual({ ok: true });
      expect(await orgOwnerId(org.id)).toBe(priya.id);
      expect(await ownerRows(org.id)).toEqual([{ userId: priya.id }]);
      expect(await requireOrgRole(jono.id, org.id, 'ADMIN')).toEqual({ ok: true, role: 'ADMIN' });

      // A refused transfer (the old Owner is no longer Owner) changes neither side.
      expect(await transferOwnership({ orgId: org.id, actorId: jono.id, targetId: jono.id })).toMatchObject({ ok: false, reason: 'not_owner' });
      expect(await orgOwnerId(org.id)).toBe(priya.id);
      expect(await ownerRows(org.id)).toEqual([{ userId: priya.id }]);
    });

    it('ORG-1 (partial) concurrent transfers serialize and leave exactly one Owner that matches ownerId', async () => {
      const { jono, org } = await seedNorthwind();
      const priya = await person('Priya Nair');
      const dana = await person('Dana Kim');
      await addMember(org.id, priya.id, 'ADMIN');
      await addMember(org.id, dana.id, 'ADMIN');

      const results = await Promise.all([
        transferOwnership({ orgId: org.id, actorId: jono.id, targetId: priya.id }),
        transferOwnership({ orgId: org.id, actorId: jono.id, targetId: dana.id }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const owners = await ownerRows(org.id);
      expect(owners).toHaveLength(1);
      expect(owners[0].userId).toBe(await orgOwnerId(org.id));
    });
  });

  describe('membership', () => {
    it('ORG-2 (partial) a user may belong to many orgs, each with its own role', async () => {
      const { org } = await seedNorthwind();
      const marcus = await person('Marcus Oyelaran');
      const other = await createOrganization({ name: 'Marcus Side Project', slug: `side-${createId()}`, ownerId: marcus.id });
      if (!other.ok) throw new Error('seed failed');
      createdOrgs.push(other.organization.id);
      await addMember(org.id, marcus.id, 'MEMBER');

      const mine = await listOrganizationsForUser(marcus.id);
      expect(mine.map((o) => [o.id, o.role]).sort()).toEqual(
        [[org.id, 'MEMBER'], [other.organization.id, 'OWNER']].sort(),
      );
    });

    it('ORG-2 (partial) role changes and removal apply to members and never to the Owner', async () => {
      const { jono, org } = await seedNorthwind();
      const priya = await person('Priya Nair');
      const marcus = await person('Marcus Oyelaran');
      await addMember(org.id, priya.id, 'ADMIN');
      await addMember(org.id, marcus.id, 'MEMBER');

      expect(await changeMemberRole({ orgId: org.id, actorId: priya.id, targetId: marcus.id, newRole: 'ADMIN' })).toEqual({ ok: true });
      expect(await requireOrgRole(marcus.id, org.id, 'ADMIN')).toEqual({ ok: true, role: 'ADMIN' });
      expect(await changeMemberRole({ orgId: org.id, actorId: priya.id, targetId: jono.id, newRole: 'MEMBER' })).toMatchObject({ ok: false, reason: 'use_ownership_transfer' });
      expect(await removeMember({ orgId: org.id, actorId: priya.id, targetId: jono.id })).toMatchObject({ ok: false, reason: 'use_ownership_transfer' });
      expect(await removeMember({ orgId: org.id, actorId: priya.id, targetId: marcus.id })).toEqual({ ok: true });
      expect(await requireOrgRole(marcus.id, org.id, 'MEMBER')).toEqual({ ok: false, status: 404, reason: 'not_member' });
      expect(await ownerRows(org.id)).toEqual([{ userId: jono.id }]);
    });
  });

  it('ORG-5 (partial) an Admin demoted after the route authorized cannot change a role or remove a member', async () => {
    const { org } = await seedNorthwind();
    const priya = await person('Priya Nair');
    const marcus = await person('Marcus Oyelaran');
    await addMember(org.id, priya.id, 'MEMBER');
    await addMember(org.id, marcus.id, 'MEMBER');

    expect(await changeMemberRole({ orgId: org.id, actorId: priya.id, targetId: marcus.id, newRole: 'ADMIN' })).toEqual({ ok: false, status: 403, reason: 'insufficient_role' });
    expect(await removeMember({ orgId: org.id, actorId: priya.id, targetId: marcus.id })).toEqual({ ok: false, status: 403, reason: 'insufficient_role' });
    expect(await requireOrgRole(marcus.id, org.id, 'MEMBER')).toEqual({ ok: true, role: 'MEMBER' });
  });

  describe('invitations', () => {
    it('ORG-3 (partial) re-inviting after expiry rotates the open invite', async () => {
      const { jono, org } = await seedNorthwind();
      const email = `lena-${createId()}@northwind.test`;
      const first = await createOrRotateInvitation({ orgId: org.id, email, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      if (!first.ok) throw new Error('invite failed');
      const [before] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, first.invitation.id));

      // A live invite blocks a duplicate (case-insensitively) …
      const dup = await createOrRotateInvitation({ orgId: org.id, email: email.toUpperCase(), role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      expect(dup).toEqual({ ok: false, status: 409, reason: 'already_invited' });

      // … an expired one is rotated in place: same row, new token hash, new expiry.
      await db.update(orgInvitations).set({ expiresAt: new Date(Date.now() - HOUR) }).where(eq(orgInvitations.id, before.id));
      const again = await createOrRotateInvitation({ orgId: org.id, email, role: 'ADMIN', invitedBy: jono.id, now: new Date(), deliver });
      if (!again.ok) throw new Error(`re-invite refused: ${again.reason}`);
      expect(again.rotated).toBe(true);
      expect(again.invitation.id).toBe(before.id);
      const rows = await db.select().from(orgInvitations).where(eq(orgInvitations.orgId, org.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].tokenHash).not.toBe(before.tokenHash);
      expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(rows[0].role).toBe('ADMIN');
    });

    it('SEAT-3 (partial) seats count accepted members plus live invites, never expired ones', async () => {
      const { jono, org } = await seedNorthwind();
      const priya = await person('Priya Nair');
      await addMember(org.id, priya.id, 'ADMIN');
      const live = await createOrRotateInvitation({ orgId: org.id, email: `tomas-${createId()}@northwind.test`, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      const dead = await createOrRotateInvitation({ orgId: org.id, email: `lena-${createId()}@northwind.test`, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      if (!live.ok || !dead.ok) throw new Error('invite failed');
      expect(await countOrgSeats(org.id)).toBe(4);

      await db.update(orgInvitations).set({ expiresAt: new Date(Date.now() - HOUR) }).where(eq(orgInvitations.id, dead.invitation.id));
      expect(await countOrgSeats(org.id)).toBe(3);
    });

    it('ORG-3 (partial) a brand-new account accepting its invite lands as a member and consumes the invite', async () => {
      const { jono, org } = await seedNorthwind();
      const email = `Tomas.Alvarez-${createId()}@Northwind.test`;
      const invite = await createOrRotateInvitation({ orgId: org.id, email, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      if (!invite.ok) throw new Error('invite failed');

      // The account is created only after the invite (sign up from the email link).
      const tomas = await factories.createUser({ name: 'Tomás Alvarez', email: email.toLowerCase() });
      createdUsers.push(tomas.id);
      const result = await acceptInvitation({ token: invite.token, userId: tomas.id, now: new Date() });
      expect(result).toEqual({ ok: true, orgId: org.id, role: 'MEMBER', joined: true });
      expect(await requireOrgRole(tomas.id, org.id, 'MEMBER')).toEqual({ ok: true, role: 'MEMBER' });
      expect(await listOpenInvitations(org.id)).toEqual([]);

      // The link is single use.
      expect(await acceptInvitation({ token: invite.token, userId: tomas.id, now: new Date() })).toMatchObject({ ok: false, reason: 'already_accepted' });
    });

    it('ORG-3 (partial) an existing account accepts as the invited role; another account cannot use the link', async () => {
      const { jono, org } = await seedNorthwind();
      const dana = await person('Dana Kim');
      const marcus = await person('Marcus Oyelaran');
      const invite = await createOrRotateInvitation({ orgId: org.id, email: dana.email, role: 'ADMIN', invitedBy: jono.id, now: new Date(), deliver });
      if (!invite.ok) throw new Error('invite failed');

      expect(await acceptInvitation({ token: invite.token, userId: marcus.id, now: new Date() })).toMatchObject({ ok: false, reason: 'email_mismatch' });
      expect(await requireOrgRole(marcus.id, org.id, 'MEMBER')).toMatchObject({ ok: false });
      expect(await acceptInvitation({ token: invite.token, userId: dana.id, now: new Date() })).toEqual({ ok: true, orgId: org.id, role: 'ADMIN', joined: true });
      expect(await createOrRotateInvitation({ orgId: org.id, email: dana.email, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver })).toEqual({ ok: false, status: 409, reason: 'already_member' });
    });

    it('ORG-3 (partial) resend replaces the link and revoke removes the open invite', async () => {
      const { jono, org } = await seedNorthwind();
      const aisha = await person('Aisha Bello');
      const invite = await createOrRotateInvitation({ orgId: org.id, email: aisha.email, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      if (!invite.ok) throw new Error('invite failed');

      const resent = await resendInvitation({ orgId: org.id, invitationId: invite.invitation.id, now: new Date(), deliver });
      if (!resent.ok) throw new Error('resend failed');
      expect(resent.token).not.toBe(invite.token);
      expect(await acceptInvitation({ token: invite.token, userId: aisha.id, now: new Date() })).toMatchObject({ ok: false, reason: 'not_found' });

      expect(await revokeInvitation({ orgId: org.id, invitationId: invite.invitation.id })).toBe(true);
      expect(await acceptInvitation({ token: resent.token, userId: aisha.id, now: new Date() })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await countOrgSeats(org.id)).toBe(1);
    });

    it('ORG-3 (partial) an expired invite cannot be accepted', async () => {
      const { jono, org } = await seedNorthwind();
      const chris = await person('Chris Rowe');
      const invite = await createOrRotateInvitation({ orgId: org.id, email: chris.email, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      if (!invite.ok) throw new Error('invite failed');
      await db.update(orgInvitations).set({ expiresAt: new Date(Date.now() - HOUR) }).where(eq(orgInvitations.id, invite.invitation.id));
      expect(await acceptInvitation({ token: invite.token, userId: chris.id, now: new Date() })).toMatchObject({ ok: false, reason: 'expired' });
      expect(await requireOrgRole(chris.id, org.id, 'MEMBER')).toMatchObject({ ok: false });
    });
  });

  describe('invitation delivery and serialization', () => {
    it('ORG-3 (partial) a resend whose email fails keeps the previously delivered link working', async () => {
      const { jono, org } = await seedNorthwind();
      const lena = await person('Lena Schulz');
      const invite = await createOrRotateInvitation({ orgId: org.id, email: lena.email, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      if (!invite.ok) throw new Error('invite failed');
      const [before] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, invite.invitation.id));

      const resent = await resendInvitation({
        orgId: org.id,
        invitationId: invite.invitation.id,
        now: new Date(Date.now() + HOUR),
        deliver: async () => { throw new Error('smtp down'); },
      });
      expect(resent).toMatchObject({ ok: false, status: 502, reason: 'delivery_failed' });
      const [after] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, invite.invitation.id));
      expect(after.tokenHash).toBe(before.tokenHash);
      expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
      expect(await acceptInvitation({ token: invite.token, userId: lena.id, now: new Date() })).toMatchObject({ ok: true, joined: true });
    });

    it('ORG-3 (partial) an invite whose email fails holds no seat; a rotated one is left as it was', async () => {
      const { jono, org } = await seedNorthwind();
      const failing = async () => { throw new Error('smtp down'); };
      const fresh = await createOrRotateInvitation({ orgId: org.id, email: `tomas-${createId()}@northwind.test`, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver: failing });
      expect(fresh).toMatchObject({ ok: false, status: 502, reason: 'delivery_failed' });
      expect(await listOpenInvitations(org.id)).toEqual([]);

      const email = `aisha-${createId()}@northwind.test`;
      const first = await createOrRotateInvitation({ orgId: org.id, email, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      if (!first.ok) throw new Error('invite failed');
      await db.update(orgInvitations).set({ expiresAt: new Date(Date.now() - HOUR) }).where(eq(orgInvitations.id, first.invitation.id));
      const [expired] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, first.invitation.id));
      const rotated = await createOrRotateInvitation({ orgId: org.id, email, role: 'ADMIN', invitedBy: jono.id, now: new Date(), deliver: failing });
      expect(rotated).toMatchObject({ ok: false, status: 502, reason: 'delivery_failed' });
      const [after] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, first.invitation.id));
      expect(after).toEqual(expired);
      expect(await countOrgSeats(org.id)).toBe(1);
    });

    /** Holds the (org, address) invite lock in its own transaction until release() is called. */
    async function holdAddressLock(orgId: string, email: string) {
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => { release = resolve; });
      let lockTaken: () => void = () => {};
      const taken = new Promise<void>((resolve) => { lockTaken = resolve; });
      const holder = db.transaction(async (tx) => {
        await lockOrgInviteAddress(tx, orgId, email);
        lockTaken();
        await held;
      });
      await taken;
      return { release: async () => { release(); await holder; } };
    }

    async function isBlocked<T>(work: Promise<T>): Promise<boolean> {
      let settled = false;
      void work.finally(() => { settled = true; }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300));
      return !settled;
    }

    it('ORG-3 (partial) creating an invite waits while the same address is locked by an acceptance', async () => {
      const { jono, org } = await seedNorthwind();
      const email = `marcus-${createId()}@northwind.test`;
      const lock = await holdAddressLock(org.id, email.toUpperCase());
      const creating = createOrRotateInvitation({ orgId: org.id, email, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      expect(await isBlocked(creating)).toBe(true);
      await lock.release();
      expect(await creating).toMatchObject({ ok: true });
    });

    it('ORG-3 (partial) accepting an invite waits while the same address is locked by an invite creation', async () => {
      const { jono, org } = await seedNorthwind();
      const marcus = await person('Marcus Oyelaran');
      const invite = await createOrRotateInvitation({ orgId: org.id, email: marcus.email, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      if (!invite.ok) throw new Error('invite failed');
      const lock = await holdAddressLock(org.id, marcus.email);
      const accepting = acceptInvitation({ token: invite.token, userId: marcus.id, now: new Date() });
      expect(await isBlocked(accepting)).toBe(true);
      await lock.release();
      expect(await accepting).toMatchObject({ ok: true, joined: true });
    });
  });

  it('ORG-6 (partial) a caller who lost ownership after the route authorized cannot delete the org', async () => {
    const { jono, org } = await seedNorthwind();
    const priya = await person('Priya Nair');
    await addMember(org.id, priya.id, 'ADMIN');
    const product = await seedDrive(jono.id, org.id, { name: 'Product' });
    expect(await transferOwnership({ orgId: org.id, actorId: jono.id, targetId: priya.id })).toEqual({ ok: true });

    const result = await deleteOrganization({ actorId: jono.id, orgId: org.id, choices: [{ driveId: product.id, action: 'trash' }], now: new Date() }, noKick);
    expect(result).toEqual({ ok: false, status: 403, reason: 'not_owner' });
    const [drive] = await db.select().from(drives).where(eq(drives.id, product.id));
    expect(drive).toMatchObject({ orgId: org.id, isTrashed: false });
  });

  describe('deletion', () => {
    it("ORG-6 deleting an org with a trashed drive puts it in the Owner's trash and deletes the org", async () => {
      const { jono, org } = await seedNorthwind();
      const priya = await person('Priya Nair');
      await addMember(org.id, priya.id, 'ADMIN');
      const trashedAt = new Date(Date.now() - 24 * HOUR);
      const oldSite = await seedDrive(priya.id, org.id, { name: 'Old Marketing Site', isTrashed: true, trashedAt });

      const result = await deleteOrganization({ actorId: jono.id, orgId: org.id, choices: [], now: new Date() }, noKick);
      expect(result).toEqual({
        ok: true,
        steps: [{ driveId: oldSite.id, driveName: 'Old Marketing Site', destination: 'owner_trash', ownerId: jono.id, trashed: true }],
      });
      const [drive] = await db.select().from(drives).where(eq(drives.id, oldSite.id));
      expect(drive.orgId).toBeNull();
      expect(drive.ownerId).toBe(jono.id);
      expect(drive.isTrashed).toBe(true);
      expect(drive.trashedAt?.getTime()).toBe(trashedAt.getTime());
      expect(await db.select().from(organizations).where(eq(organizations.id, org.id))).toEqual([]);
    });

    it('ORG-6 deleting an org never leaves a drive without an owner', async () => {
      const { jono, org } = await seedNorthwind();
      const priya = await person('Priya Nair');
      const marcus = await person('Marcus Oyelaran');
      await addMember(org.id, priya.id, 'ADMIN');
      await addMember(org.id, marcus.id, 'MEMBER');
      const product = await seedDrive(jono.id, org.id, { name: 'Product' });
      const finance = await seedDrive(priya.id, org.id, { name: 'Finance', orgVisibility: 'PRIVATE' });
      const research = await seedDrive(priya.id, org.id, { name: 'Customer Research', isTrashed: true, trashedAt: new Date() });
      // An org-materialized membership must not outlive the org.
      await db.insert(driveMembers).values({ driveId: product.id, userId: marcus.id, role: 'MEMBER', source: 'org', acceptedAt: new Date() });

      const result = await deleteOrganization({ actorId: jono.id,
        orgId: org.id,
        choices: [
          { driveId: product.id, action: 'transfer', toUserId: priya.id },
          { driveId: finance.id, action: 'trash' },
        ],
        now: new Date(),
      }, noKick);
      expect(result.ok).toBe(true);

      const after = await db.select().from(drives).where(inArray(drives.id, [product.id, finance.id, research.id]));
      for (const drive of after) {
        expect(drive.orgId).toBeNull();
        expect(drive.ownerId).toBeTruthy();
      }
      const byId = new Map(after.map((d) => [d.id, d]));
      expect(byId.get(product.id)).toMatchObject({ ownerId: priya.id, isTrashed: false });
      expect(byId.get(finance.id)).toMatchObject({ ownerId: jono.id, isTrashed: true });
      expect(byId.get(research.id)).toMatchObject({ ownerId: jono.id, isTrashed: true });
      expect(await db.select().from(driveMembers).where(eq(driveMembers.driveId, product.id))).toEqual([]);
      expect(await db.select().from(organizations).where(eq(organizations.id, org.id))).toEqual([]);
    });

    it('ORG-6 deleting an org refuses a transfer to someone outside the org and changes nothing', async () => {
      const { jono, org } = await seedNorthwind();
      const chris = await person('Chris Rowe');
      const product = await seedDrive(jono.id, org.id, { name: 'Product' });

      const result = await deleteOrganization({ actorId: jono.id,
        orgId: org.id,
        choices: [{ driveId: product.id, action: 'transfer', toUserId: chris.id }],
        now: new Date(),
      }, noKick);
      expect(result).toEqual({ ok: false, status: 400, reason: 'transfer_target_not_member', driveIds: [product.id] });
      const [drive] = await db.select().from(drives).where(eq(drives.id, product.id));
      expect(drive).toMatchObject({ orgId: org.id, ownerId: jono.id, isTrashed: false });
      expect(await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, org.id))).toHaveLength(1);
    });
  });

  describe('joining materializes Open drives', () => {
    async function seedDrives(jono: { id: string }, priya: { id: string }, orgId: string) {
      return {
        product: await seedDrive(jono.id, orgId, { name: 'Product' }),
        roadmap: await seedDrive(priya.id, orgId, { name: 'Roadmap' }),
        finance: await seedDrive(priya.id, orgId, { name: 'Finance', orgVisibility: 'RESTRICTED' }),
        legal: await seedDrive(jono.id, orgId, { name: 'Legal', orgVisibility: 'PRIVATE' }),
      };
    }

    async function rowsFor(userId: string, driveIds: string[]) {
      return db
        .select({ driveId: driveMembers.driveId, source: driveMembers.source, role: driveMembers.role, acceptedAt: driveMembers.acceptedAt })
        .from(driveMembers)
        .where(and(eq(driveMembers.userId, userId), inArray(driveMembers.driveId, driveIds)));
    }

    it('DRV-5 (partial) a joiner is materialized on every existing OPEN org drive, is a drive recipient there, and gets nothing on RESTRICTED or PRIVATE drives; events publish after commit', async () => {
      const { jono, org } = await seedNorthwind();
      const priya = await person('Priya Nair');
      await addMember(org.id, priya.id, 'ADMIN');
      const { product, roadmap, finance, legal } = await seedDrives(jono, priya, org.id);
      const allIds = [product.id, roadmap.id, finance.id, legal.id];
      const tomas = await person('Tomás Alvarez');
      const invite = await createOrRotateInvitation({ orgId: org.id, email: tomas.email, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      if (!invite.ok) throw new Error('invite failed');

      const published: OrgMembershipSyncResult[] = [];
      const rowsSeenAtPublish: number[] = [];
      const result = await acceptInvitation(
        { token: invite.token, userId: tomas.id, now: new Date() },
        {
          syncMemberAccess: syncOrgMemberAccess,
          publishSyncEvents: async (sync) => {
            published.push(sync);
            // Read on another connection: the rows are visible, so the transaction has committed.
            rowsSeenAtPublish.push((await rowsFor(tomas.id, allIds)).length);
          },
        },
      );
      expect(result).toEqual({ ok: true, orgId: org.id, role: 'MEMBER', joined: true });

      const rows = await rowsFor(tomas.id, allIds);
      expect(rows.map((r) => r.driveId).sort()).toEqual([product.id, roadmap.id].sort());
      for (const row of rows) {
        expect(row).toMatchObject({ source: 'org', role: 'MEMBER' });
        expect(row.acceptedAt).not.toBeNull();
      }
      expect(await getDriveRecipientUserIds(product.id)).toContain(tomas.id);
      expect(await getDriveRecipientUserIds(roadmap.id)).toContain(tomas.id);
      expect(await getDriveRecipientUserIds(finance.id)).not.toContain(tomas.id);
      expect(await getDriveRecipientUserIds(legal.id)).not.toContain(tomas.id);

      expect(rowsSeenAtPublish).toEqual([2]);
      expect(published).toHaveLength(1);
      expect(published[0].affectedUsers).toEqual([
        { userId: tomas.id, operation: 'member_added', driveIds: expect.arrayContaining([product.id, roadmap.id]) },
      ]);
      expect(published[0].affectedUsers[0].driveIds).toHaveLength(2);
    });

    it('DRV-5 (partial) accepting is idempotent: a second acceptance adds no row and publishes nothing', async () => {
      const { jono, org } = await seedNorthwind();
      const priya = await person('Priya Nair');
      await addMember(org.id, priya.id, 'ADMIN');
      const { product, roadmap, finance, legal } = await seedDrives(jono, priya, org.id);
      const tomas = await person('Tomás Alvarez');
      const invite = await createOrRotateInvitation({ orgId: org.id, email: tomas.email, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      if (!invite.ok) throw new Error('invite failed');
      const publishSyncEvents = vi.fn(async () => {});
      expect(
        await acceptInvitation({ token: invite.token, userId: tomas.id, now: new Date() }, { syncMemberAccess: syncOrgMemberAccess, publishSyncEvents }),
      ).toMatchObject({ ok: true, joined: true });
      expect(publishSyncEvents).toHaveBeenCalledTimes(1);
      publishSyncEvents.mockClear();
      expect(
        await acceptInvitation({ token: invite.token, userId: tomas.id, now: new Date() }, { syncMemberAccess: syncOrgMemberAccess, publishSyncEvents }),
      ).toMatchObject({ ok: false, reason: 'already_accepted' });
      expect(publishSyncEvents).not.toHaveBeenCalled();
      expect(await rowsFor(tomas.id, [product.id, roadmap.id, finance.id, legal.id])).toHaveLength(2);
    });

    it('DRV-5 (partial) an acceptance whose transaction rolls back leaves no member, no drive row and publishes nothing', async () => {
      const { jono, org } = await seedNorthwind();
      const priya = await person('Priya Nair');
      await addMember(org.id, priya.id, 'ADMIN');
      const { product, roadmap } = await seedDrives(jono, priya, org.id);
      const tomas = await person('Tomás Alvarez');
      const invite = await createOrRotateInvitation({ orgId: org.id, email: tomas.email, role: 'MEMBER', invitedBy: jono.id, now: new Date(), deliver });
      if (!invite.ok) throw new Error('invite failed');

      const publishSyncEvents = vi.fn(async () => {});
      let synced: OrgMembershipSyncResult | null = null;
      await expect(
        acceptInvitation(
          { token: invite.token, userId: tomas.id, now: new Date() },
          {
            // The real sync writes its rows, then the transaction fails after it.
            syncMemberAccess: async (orgId, userId, options) => {
              synced = await syncOrgMemberAccess(orgId, userId, options);
              throw new Error('boom after sync');
            },
            publishSyncEvents,
          },
        ),
      ).rejects.toThrow('boom after sync');

      expect(synced).not.toBeNull();
      expect(publishSyncEvents).not.toHaveBeenCalled();
      expect(await rowsFor(tomas.id, [product.id, roadmap.id])).toEqual([]);
      expect(await requireOrgRole(tomas.id, org.id, 'MEMBER')).toMatchObject({ ok: false });
      expect(await listOpenInvitations(org.id)).toHaveLength(1);
    });
  });

  it('X-6 (partial) a pending org invitation grants no drive access and lists no drive', async () => {
    flags.orgsEnabled = true;
    const { jono, org } = await seedNorthwind();
    const marcus = await person('Marcus Oyelaran');
    await addMember(org.id, marcus.id, 'MEMBER');
    const product = await seedDrive(jono.id, org.id, { name: 'Product' });
    const finance = await seedDrive(jono.id, org.id, { name: 'Finance', orgVisibility: 'RESTRICTED' });
    const legal = await seedDrive(jono.id, org.id, { name: 'Legal', orgVisibility: 'PRIVATE' });
    const productPage = await factories.createPage(product.id);
    const tomas = await person('Tomás Alvarez');
    const invite = await createOrRotateInvitation({ orgId: org.id, email: tomas.email, role: 'ADMIN', invitedBy: jono.id, now: new Date(), deliver });
    if (!invite.ok) throw new Error('invite failed');

    // Control: the org branch is live, so an accepted member does open and list the Open drive.
    expect(await getDriveAccess(product.id, marcus.id)).toMatchObject({ isMember: true });
    expect((await listAccessibleDrives(marcus.id)).map((d) => d.id)).toContain(product.id);

    for (const drive of [product, finance, legal]) {
      expect(await getDriveAccess(drive.id, tomas.id)).toEqual({ isOwner: false, isAdmin: false, isMember: false, role: null });
    }
    expect(await getUserAccessLevel(tomas.id, productPage.id)).toBeNull();
    const listed = (await listAccessibleDrives(tomas.id, { includeTrash: true })).map((d) => d.id);
    expect(listed).not.toContain(product.id);
    expect(listed).not.toContain(finance.id);
    expect(listed).not.toContain(legal.id);
  });

  describe('deletion leaves no former lead behind', () => {
    async function ownerRow(driveId: string, userId: string) {
      await db.insert(driveMembers).values({ driveId, userId, role: 'OWNER', acceptedAt: new Date() });
    }

    it('ORG-6 after deleting an org the former lead of a transferred or trashed drive cannot open, list or restore into it; the Owner keeps their own row', async () => {
      const { jono, org } = await seedNorthwind();
      const priya = await person('Priya Nair');
      const marcus = await person('Marcus Oyelaran');
      await addMember(org.id, priya.id, 'ADMIN');
      await addMember(org.id, marcus.id, 'MEMBER');
      // Priya leads Product and Finance, each with the OWNER row a personal drive carries in.
      const product = await seedDrive(priya.id, org.id, { name: 'Product' });
      const finance = await seedDrive(priya.id, org.id, { name: 'Finance', orgVisibility: 'PRIVATE' });
      const wiki = await seedDrive(jono.id, org.id, { name: 'Wiki' });
      await ownerRow(product.id, priya.id);
      await ownerRow(finance.id, priya.id);
      await ownerRow(wiki.id, jono.id);
      const productPage = await factories.createPage(product.id);
      const financePage = await factories.createPage(finance.id);

      const result = await deleteOrganization({
        actorId: jono.id,
        orgId: org.id,
        choices: [
          { driveId: product.id, action: 'transfer', toUserId: marcus.id },
          { driveId: finance.id, action: 'trash' },
          { driveId: wiki.id, action: 'trash' },
        ],
        now: new Date(),
      }, noKick);
      expect(result.ok).toBe(true);

      expect(
        await db.select().from(driveMembers).where(and(eq(driveMembers.userId, priya.id), inArray(driveMembers.driveId, [product.id, finance.id]))),
      ).toEqual([]);
      // The org Owner receives Wiki back into their own trash: their row is theirs, not a former lead's.
      expect(await db.select().from(driveMembers).where(and(eq(driveMembers.userId, jono.id), eq(driveMembers.driveId, wiki.id)))).toHaveLength(1);

      // Restoring Finance out of the Owner's trash brings no access back to Priya.
      expect(await restoreDrive(finance.id)).not.toBeNull();

      for (const orgsEnabled of [false, true]) {
        flags.orgsEnabled = orgsEnabled;
        for (const drive of [product, finance]) {
          expect(await getDriveAccess(drive.id, priya.id)).toEqual({ isOwner: false, isAdmin: false, isMember: false, role: null });
        }
        expect(await getUserAccessLevel(priya.id, productPage.id)).toBeNull();
        expect(await getUserAccessLevel(priya.id, financePage.id)).toBeNull();
        const listed = (await listAccessibleDrives(priya.id, { includeTrash: true })).map((d) => d.id);
        expect(listed).not.toContain(product.id);
        expect(listed).not.toContain(finance.id);
        expect(await getDriveAccess(product.id, marcus.id)).toMatchObject({ isOwner: true });
      }
    });

    it('ORG-6 everyone whose drive row the delete revokes is kicked from that drive\'s realtime rooms only after it commits, never the new owner, and a refused delete kicks no one', async () => {
      const { jono, org } = await seedNorthwind();
      const priya = await person('Priya Nair');
      const marcus = await person('Marcus Oyelaran');
      await addMember(org.id, priya.id, 'ADMIN');
      await addMember(org.id, marcus.id, 'MEMBER');
      const product = await seedDrive(priya.id, org.id, { name: 'Product' });
      const finance = await seedDrive(priya.id, org.id, { name: 'Finance' });
      const wiki = await seedDrive(jono.id, org.id, { name: 'Wiki' });
      await ownerRow(product.id, priya.id);
      await ownerRow(finance.id, priya.id);
      await ownerRow(wiki.id, jono.id);
      // Marcus holds org-materialized rows on Product (which he is about to own) and Finance.
      await db.insert(driveMembers).values([
        { driveId: product.id, userId: marcus.id, role: 'MEMBER', source: 'org', acceptedAt: new Date() },
        { driveId: finance.id, userId: marcus.id, role: 'MEMBER', source: 'org', acceptedAt: new Date() },
      ]);

      const kicked: { userId: string; driveId: string; rowsAtKick: number }[] = [];
      const kick = async (target: { userId: string; driveId: string }) => {
        // Read on another connection: the row is already gone, so the delete has committed.
        const rows = await db.select().from(driveMembers).where(and(eq(driveMembers.userId, target.userId), eq(driveMembers.driveId, target.driveId)));
        kicked.push({ ...target, rowsAtKick: rows.length });
      };

      const refused = await deleteOrganization(
        { actorId: jono.id, orgId: org.id, choices: [{ driveId: product.id, action: 'trash' }], now: new Date() },
        { kick },
      );
      expect(refused).toMatchObject({ ok: false, reason: 'missing_choice' });
      expect(kicked).toEqual([]);

      const result = await deleteOrganization(
        {
          actorId: jono.id,
          orgId: org.id,
          choices: [
            { driveId: product.id, action: 'transfer', toUserId: marcus.id },
            { driveId: finance.id, action: 'trash' },
            { driveId: wiki.id, action: 'trash' },
          ],
          now: new Date(),
        },
        { kick },
      );
      expect(result.ok).toBe(true);
      const byKey = (a: { userId: string; driveId: string }, b: { userId: string; driveId: string }) =>
        `${a.driveId}:${a.userId}`.localeCompare(`${b.driveId}:${b.userId}`);
      expect(kicked.sort(byKey)).toEqual(
        [
          { userId: priya.id, driveId: product.id, rowsAtKick: 0 },
          { userId: priya.id, driveId: finance.id, rowsAtKick: 0 },
          { userId: marcus.id, driveId: finance.id, rowsAtKick: 0 },
        ].sort(byKey),
      );
    });

    it('ORG-6 a live drive without a deletion choice refuses the delete and nothing moves', async () => {
      const { jono, org } = await seedNorthwind();
      const priya = await person('Priya Nair');
      await addMember(org.id, priya.id, 'ADMIN');
      const product = await seedDrive(jono.id, org.id, { name: 'Product' });
      const finance = await seedDrive(priya.id, org.id, { name: 'Finance' });

      const result = await deleteOrganization({
        actorId: jono.id,
        orgId: org.id,
        choices: [{ driveId: product.id, action: 'trash' }],
        now: new Date(),
      }, noKick);
      expect(result).toEqual({ ok: false, status: 400, reason: 'missing_choice', driveIds: [finance.id] });
      const after = await db.select().from(drives).where(inArray(drives.id, [product.id, finance.id]));
      const byId = new Map(after.map((d) => [d.id, d]));
      expect(byId.get(product.id)).toMatchObject({ orgId: org.id, ownerId: jono.id, isTrashed: false });
      expect(byId.get(finance.id)).toMatchObject({ orgId: org.id, ownerId: priya.id, isTrashed: false });
      expect(await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, org.id))).toHaveLength(1);
    });
  });
});

/**
 * Guests held by the org's guests policy — REAL Postgres (Spec POL-1, POL-2, X-6).
 *
 * Off PARKS existing guests: their member row and page grants leave the live tables (so the real resolver sees no
 * access) and sit in org_guest_holds as a full snapshot; turning the policy back restores them exactly. The
 * approval queue holds outsiders without granting anything.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/guest-holds.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('../../audit/org-audit', () => ({ recordOrgAuditEvent: vi.fn(async () => {}) }));
vi.mock('../revocation-kick', () => ({ kickForDriveMembershipRevocation: vi.fn(async () => {}) }));

import { updateOrgPolicies } from '../../organizations/policies';
import { getUserAccessLevel, isUserDriveMember } from '../permissions';
import { kickForDriveMembershipRevocation } from '../revocation-kick';
import {
  claimPendingGuestApproval,
  listPendingGuestApprovals,
  listSuspendedOrgGuests,
  requestGuestApproval,
  suspendOrgGuests,
} from '../guest-holds';

const run = createId().slice(0, 8);
const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };

interface World {
  orgId: string;
  otherOrgId: string;
  owner: string;
  member: string;
  guest: string;
  pageGuest: string;
  orgDrive: string;
  otherDrive: string;
  personalDrive: string;
  personalOwner: string;
  page: string;
  page2: string;
}
let w: World;

async function cleanup() {
  if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
  if (created.orgIds.length) {
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, created.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  }
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.driveIds = [];
  created.orgIds = [];
}

beforeEach(async () => {
  vi.mocked(kickForDriveMembershipRevocation).mockClear();
  const mk = async () => {
    const u = await factories.createUser();
    created.userIds.push(u.id);
    return u.id;
  };
  const [owner, member, guest, pageGuest, otherOwner, personalOwner] = [await mk(), await mk(), await mk(), await mk(), await mk(), await mk()];
  const orgId = createId();
  const otherOrgId = createId();
  created.orgIds.push(orgId, otherOrgId);
  await db.insert(organizations).values([
    { id: orgId, name: 'Northwind', slug: `nw-${run}-${createId().slice(0, 4)}`, ownerId: owner },
    { id: otherOrgId, name: 'Other', slug: `ot-${run}-${createId().slice(0, 4)}`, ownerId: otherOwner },
  ]);
  await db.insert(orgMembers).values([
    { orgId, userId: owner, role: 'OWNER' },
    { orgId, userId: member, role: 'MEMBER' },
    { orgId: otherOrgId, userId: otherOwner, role: 'OWNER' },
  ]);
  const mkDrive = async (ownerId: string, org: string | null) => {
    const d = await factories.createDrive(ownerId);
    created.driveIds.push(d.id);
    if (org) await db.update(drives).set({ orgId: org, orgVisibility: 'PRIVATE' }).where(eq(drives.id, d.id));
    return d.id;
  };
  const orgDrive = await mkDrive(owner, orgId);
  const otherDrive = await mkDrive(otherOwner, otherOrgId);
  const personalDrive = await mkDrive(personalOwner, null);
  const page = (await factories.createPage(orgDrive, { isPrivate: true })).id;
  const page2 = (await factories.createPage(orgDrive, { isPrivate: true })).id;
  w = { orgId, otherOrgId, owner, member, guest, pageGuest, orgDrive, otherDrive, personalDrive, personalOwner, page, page2 };
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

const setGuests = (guests: 'off' | 'approve' | 'on', orgId = w.orgId) => updateOrgPolicies({ orgId, actorId: w.owner, patch: { guests } });

/** A full guest: a MEMBER-role invite with a view grant on `page` and an edit grant on `page2`. */
async function seedMemberGuest() {
  await db.insert(driveMembers).values({ driveId: w.orgDrive, userId: w.guest, role: 'MEMBER', acceptedAt: new Date(), invitedBy: w.owner });
  await db.insert(pagePermissions).values([
    { pageId: w.page, userId: w.guest, canView: true, canEdit: false, canShare: false, canDelete: false, grantedBy: w.owner },
    { pageId: w.page2, userId: w.guest, canView: true, canEdit: true, canShare: false, canDelete: false, grantedBy: w.owner, expiresAt: new Date(Date.now() + 86_400_000) },
  ]);
}
/** A page-link guest: a GUEST row and one grant. */
async function seedPageGuest() {
  await db.insert(driveMembers).values({ driveId: w.orgDrive, userId: w.pageGuest, role: 'GUEST', acceptedAt: new Date() });
  await db.insert(pagePermissions).values({ pageId: w.page, userId: w.pageGuest, canView: true, canEdit: false, canShare: false, canDelete: false });
}
const memberRows = (userId: string, driveId = w.orgDrive) => db.select().from(driveMembers).where(and(eq(driveMembers.driveId, driveId), eq(driveMembers.userId, userId)));
const grantRows = (userId: string) => db.select().from(pagePermissions).where(eq(pagePermissions.userId, userId));
const holdsOf = (orgId = w.orgId, state: 'suspended' | 'pending_approval' = 'suspended') => db.select().from(orgGuestHolds).where(and(eq(orgGuestHolds.orgId, orgId), eq(orgGuestHolds.state, state)));

describe('guests off PARKS existing guests', () => {
  it('POL-1 (partial) POL-2 (partial) X-6 (partial) the real resolver sees no access for a parked guest — not the drive, not the pages they were given — and full access again after restore', async () => {
    await seedMemberGuest();
    await seedPageGuest();
    expect(await isUserDriveMember(w.guest, w.orgDrive)).toBe(true);
    expect((await getUserAccessLevel(w.guest, w.page))?.canView).toBe(true);
    expect((await getUserAccessLevel(w.pageGuest, w.page))?.canView).toBe(true);

    await setGuests('off');

    expect(await isUserDriveMember(w.guest, w.orgDrive)).toBe(false);
    expect(await getUserAccessLevel(w.guest, w.page)).toBeNull();
    expect(await getUserAccessLevel(w.guest, w.page2)).toBeNull();
    // A page-link guest (GUEST row + one grant) loses the page too: the grant lived outside the member row.
    expect(await getUserAccessLevel(w.pageGuest, w.page)).toBeNull();

    await setGuests('on');

    expect(await isUserDriveMember(w.guest, w.orgDrive)).toBe(true);
    expect(await getUserAccessLevel(w.guest, w.page2)).toMatchObject({ canView: true, canEdit: true });
    expect((await getUserAccessLevel(w.pageGuest, w.page))?.canView).toBe(true);
  });

  it('POL-1 (partial) nothing is destroyed: the hold carries the whole member row and every grant, and restore puts back exactly those columns', async () => {
    await seedMemberGuest();
    const [rowBefore] = await memberRows(w.guest);
    const grantsBefore = (await grantRows(w.guest)).sort((a, b) => a.pageId.localeCompare(b.pageId));

    const off = await setGuests('off');
    if (!off.ok) throw new Error('expected ok');

    expect(await memberRows(w.guest)).toEqual([]);
    expect(await grantRows(w.guest)).toEqual([]);
    const [hold] = await holdsOf();
    expect(hold).toMatchObject({ userId: w.guest, driveId: w.orgDrive, state: 'suspended' });
    expect(hold.parked?.grants).toHaveLength(2);
    expect(off.suspended.map((s) => [s.kind, s.resourceType, s.id, s.userId])).toEqual([['guests', 'guest_hold', hold.id, w.guest]]);

    await setGuests('approve');

    const [rowAfter] = await memberRows(w.guest);
    expect(rowAfter).toEqual(rowBefore);
    expect((await grantRows(w.guest)).sort((a, b) => a.pageId.localeCompare(b.pageId))).toEqual(grantsBefore);
    expect(await holdsOf()).toEqual([]);
  });

  it('POL-1 (partial) X-6 (partial) org members, the drive lead (even one outside the org), other orgs and personal drives are never parked', async () => {
    await db.insert(driveMembers).values([
      { driveId: w.orgDrive, userId: w.member, role: 'MEMBER', acceptedAt: new Date() },
      { driveId: w.otherDrive, userId: w.guest, role: 'MEMBER', acceptedAt: new Date() },
      { driveId: w.personalDrive, userId: w.guest, role: 'MEMBER', acceptedAt: new Date() },
    ]);
    const [legacy] = await db.insert(drives).values({ name: 'Legacy', slug: `legacy-${run}`, ownerId: w.personalOwner, orgId: w.orgId, orgVisibility: 'OPEN', updatedAt: new Date() }).returning({ id: drives.id });
    created.driveIds.push(legacy.id);
    await db.insert(driveMembers).values({ driveId: legacy.id, userId: w.personalOwner, role: 'OWNER', acceptedAt: new Date() });

    await setGuests('off');

    expect(await memberRows(w.member)).toHaveLength(1);
    expect(await memberRows(w.guest, w.otherDrive)).toHaveLength(1);
    expect(await memberRows(w.guest, w.personalDrive)).toHaveLength(1);
    expect(await memberRows(w.personalOwner, legacy.id)).toHaveLength(1);
    expect(await holdsOf()).toEqual([]);
  });

  it('POL-1 (partial) re-running the suspension parks nothing twice', async () => {
    await seedMemberGuest();
    await setGuests('off');
    const again = await db.transaction((tx) => suspendOrgGuests(tx, w.orgId));
    expect(again).toEqual([]);
    expect(await holdsOf()).toHaveLength(1);
  });

  it('POL-1 (partial) X-6 (partial) realtime: a parked guest is evicted from the drive rooms at once', async () => {
    await seedMemberGuest();
    await setGuests('off');
    expect(kickForDriveMembershipRevocation).toHaveBeenCalledWith({ userId: w.guest, driveId: w.orgDrive, reason: 'member_removed' });
  });

  it('POL-1 (partial) a grant whose page was deleted while the guest was parked is skipped on restore; the rest come back', async () => {
    await seedMemberGuest();
    await setGuests('off');
    await db.delete((await import('@pagespace/db/schema/core')).pages).where(eq((await import('@pagespace/db/schema/core')).pages.id, w.page2));
    await setGuests('on');
    expect((await grantRows(w.guest)).map((g) => g.pageId)).toEqual([w.page]);
  });

  it('POL-1 (partial) a guest who rejoined some other way while parked keeps that row; the hold is dropped without overwriting it', async () => {
    await seedMemberGuest();
    await setGuests('off');
    await db.insert(driveMembers).values({ driveId: w.orgDrive, userId: w.guest, role: 'ADMIN', acceptedAt: new Date() });
    await setGuests('on');
    const rows = await memberRows(w.guest);
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('ADMIN');
    expect(await holdsOf()).toEqual([]);
  });

  it('POL-1 (partial) a hold of a drive that has LEFT the org stays parked: the person does not regain access on a drive the org no longer owns', async () => {
    await seedMemberGuest();
    await setGuests('off');
    await db.update(drives).set({ orgId: null, orgVisibility: 'OPEN' }).where(eq(drives.id, w.orgDrive));
    await setGuests('on');
    expect(await memberRows(w.guest)).toEqual([]);
    expect(await holdsOf()).toHaveLength(1);
  });

  it('POL-1 (partial) the suspended list is bounded and counts the whole set', async () => {
    await seedMemberGuest();
    await seedPageGuest();
    await setGuests('off');
    const page = await listSuspendedOrgGuests(w.orgId, 1);
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
  });
});

describe('the approval queue', () => {
  it('POL-2 (partial) a queued outsider holds NO access — no member row, no grant — until an Owner or Admin acts', async () => {
    await requestGuestApproval({ orgId: w.orgId, driveId: w.orgDrive, userId: w.guest, origin: 'invite', request: { role: 'MEMBER', invitedBy: w.owner }, requestedBy: w.owner });
    expect(await isUserDriveMember(w.guest, w.orgDrive)).toBe(false);
    expect(await memberRows(w.guest)).toEqual([]);
    expect(await getUserAccessLevel(w.guest, w.page)).toBeNull();
    expect((await listPendingGuestApprovals(w.orgId, 10)).total).toBe(1);
  });

  it('POL-2 (partial) asking twice for the same person and drive refreshes the one request; an invitee with no account queues by email, case-insensitively', async () => {
    const ask = (request: object) => requestGuestApproval({ orgId: w.orgId, driveId: w.orgDrive, userId: w.guest, origin: 'invite', request, requestedBy: w.owner });
    await ask({ role: 'MEMBER' });
    await ask({ role: 'ADMIN' });
    const pending = await holdsOf(w.orgId, 'pending_approval');
    expect(pending).toHaveLength(1);
    expect(pending[0].request).toEqual({ role: 'ADMIN' });

    const byEmail = (email: string) => requestGuestApproval({ orgId: w.orgId, driveId: w.orgDrive, email, origin: 'invite', request: { role: 'MEMBER' }, requestedBy: w.owner });
    await byEmail(`New.Person-${run}@Example.test`);
    await byEmail(`new.person-${run}@example.test`);
    expect(await holdsOf(w.orgId, 'pending_approval')).toHaveLength(2);
  });

  it('POL-2 (partial) a request names exactly one of a user or an email', async () => {
    await expect(requestGuestApproval({ orgId: w.orgId, driveId: w.orgDrive, origin: 'invite', request: {}, requestedBy: w.owner })).rejects.toThrow('exactly one');
    await expect(requestGuestApproval({ orgId: w.orgId, driveId: w.orgDrive, userId: w.guest, email: 'a@b.test', origin: 'invite', request: {}, requestedBy: w.owner })).rejects.toThrow('exactly one');
  });

  it('POL-2 (partial) X-6 (partial) claiming a request takes it off the queue and hands it back ONCE; another org, a repeat and a missing id all answer null', async () => {
    const item = await requestGuestApproval({ orgId: w.orgId, driveId: w.orgDrive, userId: w.guest, origin: 'page_link', request: { pageId: w.page, linkId: 'l1' }, requestedBy: null });

    expect(await claimPendingGuestApproval({ orgId: w.otherOrgId, holdId: item.holdId })).toBeNull();
    expect(await claimPendingGuestApproval({ orgId: w.orgId, holdId: 'nope' })).toBeNull();
    const claimed = await claimPendingGuestApproval({ orgId: w.orgId, holdId: item.holdId });
    expect(claimed).toMatchObject({ userId: w.guest, driveId: w.orgDrive, origin: 'page_link', request: { pageId: w.page, linkId: 'l1' } });
    expect(await claimPendingGuestApproval({ orgId: w.orgId, holdId: item.holdId })).toBeNull();
    expect((await listPendingGuestApprovals(w.orgId, 10)).total).toBe(0);
  });

  it('POL-2 (partial) a pending request is never treated as a suspended guest: guests off leaves the queue alone and approve/restore never admits it', async () => {
    await requestGuestApproval({ orgId: w.orgId, driveId: w.orgDrive, userId: w.guest, origin: 'invite', request: {}, requestedBy: w.owner });
    await setGuests('off');
    await setGuests('on');
    expect(await holdsOf(w.orgId, 'pending_approval')).toHaveLength(1);
    expect(await memberRows(w.guest)).toEqual([]);
  });
});

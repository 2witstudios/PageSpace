/**
 * Existing access that ENTERS an org drive is decided by the org's guests policy too — REAL Postgres (Spec POL-2,
 * X-6; independent review of #2762: P1-1, P2-1, P2-7, P2-8).
 *
 * - A drive moved into an org brings its outsiders: guests off parks them, approve queues them, on keeps them.
 * - A member who leaves keeps invited rows and page grants: they are now an outsider's, and the policy decides them.
 * - An outsider's MCP token with an explicit role on an org drive is parked with them and comes back with them.
 * - Restoring parked access never wedges on a reference that went away while it was parked (a deleted sharer, a
 *   deleted custom role), and a grant whose page left the drive does not follow it.
 * - admitReentry, the one decision every restore, rollback and redo asks before it puts access back.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/guest-reentry.integration.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { mcpTokens, users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles, mcpTokenDrives, pagePermissions } from '@pagespace/db/schema/members';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('../../audit/org-audit', () => ({ recordOrgAuditEvent: vi.fn(async () => {}), recordOrgAuditEventAfterCommit: vi.fn(async () => true) }));
vi.mock('../revocation-kick', () => ({ kickForDriveMembershipRevocation: vi.fn(async () => {}), kickForPagePermissionRevocation: vi.fn(async () => {}) }));

import { updateOrgPolicies } from '../../organizations/policies';
import { leaveOrganization } from '../../organizations/leave';
import { moveDriveToOrg, type OrgDriveServiceDeps } from '../../services/org-drive-service';
import { orgDriveServiceDeps } from '../../services/org-drive-service-deps';
import { getUserAccessLevel } from '../permissions';
import { admitReentry, claimPendingGuestApproval, consumeApprovedInvitation, holdOrgGuestsUnderPolicy, listPendingGuestApprovalViews, markApprovedInvitation } from '../guest-holds';
import { lockOrgsOfDrivesForShare } from '../../organizations/policy-reader';
import { completeApprovedPageGrant } from '../page-grant-admission';

const deps: OrgDriveServiceDeps = { ...orgDriveServiceDeps, syncOrgMembership: async () => async () => {} };
const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };

interface World {
  orgId: string;
  owner: string;
  member: string;
  outsider: string;
  sharer: string;
  orgDrive: string;
  orgPage: string;
}
let w: World;

async function cleanup() {
  // Holds, grants, member rows, roles and token scopes go with their drive; then org rows; users (and their tokens) last.
  if (created.driveIds.length) await db.delete(drives).where(inArray(drives.id, created.driveIds));
  if (created.orgIds.length) {
    await db.delete(orgGuestHolds).where(inArray(orgGuestHolds.orgId, created.orgIds));
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, created.orgIds));
    await db.delete(organizations).where(inArray(organizations.id, created.orgIds));
  }
  if (created.userIds.length) await db.delete(users).where(inArray(users.id, created.userIds));
  created.userIds = [];
  created.driveIds = [];
  created.orgIds = [];
}

const mkUser = async () => {
  const u = await factories.createUser();
  created.userIds.push(u.id);
  return u.id;
};
const mkDrive = async (ownerId: string) => {
  const d = await factories.createDrive(ownerId);
  created.driveIds.push(d.id);
  return d.id;
};

beforeEach(async () => {
  const [owner, member, outsider, sharer] = [await mkUser(), await mkUser(), await mkUser(), await mkUser()];
  const orgId = createId();
  created.orgIds.push(orgId);
  await db.insert(organizations).values({ id: orgId, name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner });
  await db.insert(orgMembers).values([{ orgId, userId: owner, role: 'OWNER' }, { orgId, userId: member, role: 'MEMBER' }]);
  const orgDrive = await mkDrive(owner);
  await db.update(drives).set({ orgId, orgVisibility: 'RESTRICTED' }).where(eq(drives.id, orgDrive));
  const orgPage = (await factories.createPage(orgDrive)).id;
  w = { orgId, owner, member, outsider, sharer, orgDrive, orgPage };
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

const setGuests = async (guests: 'off' | 'approve' | 'on') => {
  const r = await updateOrgPolicies({ orgId: w.orgId, actorId: w.owner, patch: { guests } });
  if (!r.ok) throw new Error(`guests ${guests} refused`);
};
const EDIT = { canView: true, canEdit: true, canShare: false, canDelete: false };
const holds = (state: 'suspended' | 'pending_approval', userId = w.outsider) =>
  db.select().from(orgGuestHolds).where(and(eq(orgGuestHolds.orgId, w.orgId), eq(orgGuestHolds.userId, userId), eq(orgGuestHolds.state, state)));

/** An owner's personal drive where an outsider is an invited member with an edit grant and an explicit-role token. */
async function personalDriveWithOutsider() {
  const drive = await mkDrive(w.owner);
  const page = (await factories.createPage(drive)).id;
  await db.insert(driveMembers).values({ driveId: drive, userId: w.outsider, role: 'MEMBER', acceptedAt: new Date(), invitedBy: w.owner });
  await db.insert(pagePermissions).values({ pageId: page, userId: w.outsider, ...EDIT, grantedBy: w.owner });
  const [token] = await db.insert(mcpTokens).values({ userId: w.outsider, tokenHash: createId(), tokenPrefix: 'mcp_x', name: 'cli' }).returning({ id: mcpTokens.id });
  await db.insert(mcpTokenDrives).values({ tokenId: token.id, driveId: drive, role: 'MEMBER' });
  return { drive, page, tokenId: token.id };
}

describe('a drive moved into an org brings its outsiders under the guests policy', () => {
  it('POL-2 (partial) X-6 (partial) guests OFF: the moved drive\'s outsider loses the member row, the edit grant and the token scope — parked, restored when guests come back on', async () => {
    await setGuests('off');
    const { drive, page, tokenId } = await personalDriveWithOutsider();
    expect((await getUserAccessLevel(w.outsider, page))?.canEdit).toBe(true);

    expect(await moveDriveToOrg(w.owner, drive, { orgId: w.orgId, orgVisibility: 'RESTRICTED' }, deps)).toMatchObject({ ok: true });

    expect(await getUserAccessLevel(w.outsider, page)).toBeNull();
    expect(await db.select().from(mcpTokenDrives).where(eq(mcpTokenDrives.driveId, drive))).toEqual([]);
    const [hold] = await holds('suspended');
    expect(hold.parked?.member).toMatchObject({ userId: w.outsider, driveId: drive });
    expect(hold.parked?.tokenScopes).toEqual([expect.objectContaining({ tokenId, role: 'MEMBER' })]);

    await setGuests('on');
    expect((await getUserAccessLevel(w.outsider, page))?.canEdit).toBe(true);
    expect(await db.select({ role: mcpTokenDrives.role }).from(mcpTokenDrives).where(eq(mcpTokenDrives.driveId, drive))).toEqual([{ role: 'MEMBER' }]);
  });

  it('POL-2 (partial) guests APPROVE: the outsider is queued with exactly what they held and holds nothing until approved; approving gives it back', async () => {
    await setGuests('approve');
    const { drive, page } = await personalDriveWithOutsider();
    await moveDriveToOrg(w.owner, drive, { orgId: w.orgId, orgVisibility: 'RESTRICTED' }, deps);

    expect(await getUserAccessLevel(w.outsider, page)).toBeNull();
    const [pending] = await holds('pending_approval');
    expect(pending).toMatchObject({ origin: 'page_grant', driveId: drive });
    expect(pending.request.permissions).toEqual([{ pageId: page, ...EDIT, expiresAt: null }]);

    const claim = await claimPendingGuestApproval({ orgId: w.orgId, holdId: pending.id });
    if (!claim) throw new Error('claim');
    expect(await completeApprovedPageGrant(claim)).toMatchObject({ ok: true });
    expect((await getUserAccessLevel(w.outsider, page))?.canEdit).toBe(true);
    expect(await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, drive), eq(driveMembers.userId, w.outsider)))).toHaveLength(1);
  });

  it('POL-2 (partial) guests ON: the outsider keeps their access, and org members are never held', async () => {
    const { drive, page } = await personalDriveWithOutsider();
    await db.insert(driveMembers).values({ driveId: drive, userId: w.member, role: 'MEMBER', acceptedAt: new Date() });
    await moveDriveToOrg(w.owner, drive, { orgId: w.orgId, orgVisibility: 'RESTRICTED' }, deps);
    expect((await getUserAccessLevel(w.outsider, page))?.canEdit).toBe(true);
    expect(await db.select().from(orgGuestHolds).where(eq(orgGuestHolds.orgId, w.orgId))).toEqual([]);
  });
});

describe('a member who leaves becomes an outsider of what they kept', () => {
  it('POL-2 (partial) X-6 (partial) guests OFF: a departed member\'s invited row and page grant are parked, not kept', async () => {
    await db.insert(driveMembers).values({ driveId: w.orgDrive, userId: w.member, role: 'MEMBER', source: 'invite', acceptedAt: new Date() });
    await db.insert(pagePermissions).values({ pageId: w.orgPage, userId: w.member, ...EDIT, grantedBy: w.owner });
    await setGuests('off');
    expect((await getUserAccessLevel(w.member, w.orgPage))?.canEdit).toBe(true);

    expect(await leaveOrganization(w.member, w.orgId)).toMatchObject({ ok: true, heldAsGuest: 1 });

    expect(await getUserAccessLevel(w.member, w.orgPage)).toBeNull();
    expect(await holds('suspended', w.member)).toHaveLength(1);
  });

  it('POL-2 (partial) guests ON: a departed member keeps an invited row as an outsider, as before', async () => {
    await db.insert(driveMembers).values({ driveId: w.orgDrive, userId: w.member, role: 'MEMBER', source: 'invite', acceptedAt: new Date() });
    expect(await leaveOrganization(w.member, w.orgId)).toMatchObject({ ok: true, heldAsGuest: 0 });
    expect(await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, w.orgDrive), eq(driveMembers.userId, w.member)))).toHaveLength(1);
  });
});

describe('explicit-role MCP token scopes of outsiders', () => {
  it('POL-2 (partial) X-6 (partial) guests OFF parks an outsider\'s explicit-role token scope on an org drive and ON restores it; an inherit scope is left (it follows its owner)', async () => {
    const [token] = await db.insert(mcpTokens).values({ userId: w.outsider, tokenHash: createId(), tokenPrefix: 'mcp_x', name: 'cli' }).returning({ id: mcpTokens.id });
    const [inherit] = await db.insert(mcpTokens).values({ userId: w.outsider, tokenHash: createId(), tokenPrefix: 'mcp_y', name: 'inherit' }).returning({ id: mcpTokens.id });
    await db.insert(mcpTokenDrives).values([{ tokenId: token.id, driveId: w.orgDrive, role: 'MEMBER' }, { tokenId: inherit.id, driveId: w.orgDrive, role: null }]);

    await setGuests('off');
    expect((await db.select({ tokenId: mcpTokenDrives.tokenId }).from(mcpTokenDrives).where(eq(mcpTokenDrives.driveId, w.orgDrive))).map((r) => r.tokenId)).toEqual([inherit.id]);

    await setGuests('on');
    expect((await db.select({ tokenId: mcpTokenDrives.tokenId }).from(mcpTokenDrives).where(eq(mcpTokenDrives.driveId, w.orgDrive))).map((r) => r.tokenId).sort()).toEqual([token.id, inherit.id].sort());
  });
});

describe('restoring parked access never wedges', () => {
  it('POL-2 (partial) guests back ON after the person who shared the page deleted their account: the grant comes back with no granter, and the change does not fail', async () => {
    await db.insert(pagePermissions).values({ pageId: w.orgPage, userId: w.outsider, ...EDIT, grantedBy: w.sharer });
    await setGuests('off');
    await db.delete(users).where(eq(users.id, w.sharer));

    await setGuests('on');

    const [grant] = await db.select().from(pagePermissions).where(eq(pagePermissions.userId, w.outsider));
    expect(grant).toMatchObject({ pageId: w.orgPage, canEdit: true, grantedBy: null });
  });

  it('POL-2 (partial) a parked member row whose custom role and inviter are gone comes back as a plain member with no inviter', async () => {
    const [role] = await db.insert(driveRoles).values({ driveId: w.orgDrive, name: 'Reviewers', permissions: {}, updatedAt: new Date() }).returning({ id: driveRoles.id });
    await db.insert(driveMembers).values({ driveId: w.orgDrive, userId: w.outsider, role: 'MEMBER', customRoleId: role.id, acceptedAt: new Date(), invitedBy: w.sharer });
    await setGuests('off');
    await db.delete(driveRoles).where(eq(driveRoles.id, role.id));
    await db.delete(users).where(eq(users.id, w.sharer));

    await setGuests('on');

    expect(await db.select({ customRoleId: driveMembers.customRoleId, invitedBy: driveMembers.invitedBy }).from(driveMembers).where(eq(driveMembers.userId, w.outsider))).toEqual([{ customRoleId: null, invitedBy: null }]);
  });

  it('POL-2 (partial) a page that moved to another drive while its grant was parked does not take the grant with it', async () => {
    await db.insert(pagePermissions).values({ pageId: w.orgPage, userId: w.outsider, ...EDIT, grantedBy: w.owner });
    await setGuests('off');
    const elsewhere = await mkDrive(w.owner);
    await db.update(pages).set({ driveId: elsewhere }).where(eq(pages.id, w.orgPage));

    await setGuests('on');

    expect(await db.select().from(pagePermissions).where(eq(pagePermissions.userId, w.outsider))).toEqual([]);
  });
});

describe('admitReentry, asked by every restore, rollback and redo', () => {
  const ask = (userId: string, member: Record<string, unknown> | null = null) =>
    db.transaction((tx) => admitReentry(tx, { driveId: w.orgDrive, userId, member, grants: [{ pageId: w.orgPage, ...EDIT }], requestedBy: w.owner }));

  it('POL-2 (partial) X-6 (partial) off refuses an outsider, approve queues them (nothing written), on and org members admit', async () => {
    await setGuests('off');
    expect(await ask(w.outsider)).toEqual({ outcome: 'refused' });
    expect(await ask(w.member)).toEqual({ outcome: 'admit' });

    await setGuests('approve');
    expect(await ask(w.outsider)).toMatchObject({ outcome: 'held' });
    const [pending] = await holds('pending_approval');
    expect(pending.request.permissions).toEqual([{ pageId: w.orgPage, ...EDIT, expiresAt: null }]);

    await setGuests('on');
    expect(await ask(w.outsider)).toEqual({ outcome: 'admit' });
  });

  it('POL-2 (partial) a grant for an admitted guest (an accepted member row on the drive) is admitted under approve; their member row is not', async () => {
    await db.insert(driveMembers).values({ driveId: w.orgDrive, userId: w.outsider, role: 'MEMBER', acceptedAt: new Date() });
    await setGuests('approve');
    expect(await ask(w.outsider)).toEqual({ outcome: 'admit' });
    expect(await ask(w.outsider, { role: 'MEMBER' })).toMatchObject({ outcome: 'held' });
  });
});

describe('approve mode replays exactly what was held (independent re-verify of #2762)', () => {
  it('POL-2 (partial) a queued grant keeps its expiry and an already-expired one is never queued, so approving neither extends nor resurrects access', async () => {
    await setGuests('approve');
    const drive = await mkDrive(w.owner);
    const expiredPage = (await factories.createPage(drive)).id;
    const soonPage = (await factories.createPage(drive)).id;
    const soon = new Date(Date.now() + 3_600_000);
    await db.insert(pagePermissions).values([
      { pageId: expiredPage, userId: w.outsider, ...EDIT, grantedBy: w.owner, expiresAt: new Date(Date.now() - 86_400_000) },
      { pageId: soonPage, userId: w.outsider, ...EDIT, grantedBy: w.owner, expiresAt: soon },
    ]);
    await moveDriveToOrg(w.owner, drive, { orgId: w.orgId, orgVisibility: 'RESTRICTED' }, deps);

    const [pending] = await holds('pending_approval');
    expect(pending.request.permissions).toEqual([{ pageId: soonPage, ...EDIT, expiresAt: soon.toISOString() }]);
    const claim = await claimPendingGuestApproval({ orgId: w.orgId, holdId: pending.id });
    if (!claim) throw new Error('claim');
    await completeApprovedPageGrant(claim);

    expect(await getUserAccessLevel(w.outsider, expiredPage)).toBeNull();
    const [kept] = await db.select().from(pagePermissions).where(and(eq(pagePermissions.userId, w.outsider), eq(pagePermissions.pageId, soonPage)));
    expect(kept.expiresAt?.toISOString()).toBe(soon.toISOString());
  });

  it('POL-2 (partial) admitReentry never queues a grant that has already expired', async () => {
    await setGuests('approve');
    const outcome = await db.transaction((tx) => admitReentry(tx, {
      driveId: w.orgDrive, userId: w.outsider, grants: [{ pageId: w.orgPage, ...EDIT, expiresAt: new Date(Date.now() - 1000) }], requestedBy: w.owner,
    }));
    expect(outcome).toEqual({ outcome: 'admit' });
    expect(await holds('pending_approval')).toEqual([]);
  });

  it('POL-2 (partial) X-6 (partial) pages moved in under approve: an outsider with only a PENDING invitation row on the drive is queued, not let through; an accepted guest keeps the grant', async () => {
    await setGuests('approve');
    const [pendingGuest, acceptedGuest] = [w.outsider, await mkUser()];
    await db.insert(driveMembers).values([
      { driveId: w.orgDrive, userId: pendingGuest, role: 'MEMBER', acceptedAt: null, invitedBy: w.owner },
      { driveId: w.orgDrive, userId: acceptedGuest, role: 'MEMBER', acceptedAt: new Date(), invitedBy: w.owner },
    ]);
    await db.insert(pagePermissions).values([
      { pageId: w.orgPage, userId: pendingGuest, ...EDIT, grantedBy: w.owner },
      { pageId: w.orgPage, userId: acceptedGuest, ...EDIT, grantedBy: w.owner },
    ]);
    await db.transaction((tx) => holdOrgGuestsUnderPolicy(tx, { orgId: w.orgId, driveId: w.orgDrive, pageIds: [w.orgPage] }));

    expect(await db.select().from(pagePermissions).where(eq(pagePermissions.userId, pendingGuest))).toEqual([]);
    expect(await holds('pending_approval', pendingGuest)).toHaveLength(1);
    expect(await db.select().from(pagePermissions).where(eq(pagePermissions.userId, acceptedGuest))).toHaveLength(1);
  });

  it('POL-2 (partial) an approval admits exactly the invitation that was approved: another invitation to the same address is not admitted by it, and guests OFF withdraws every unused approval', async () => {
    await setGuests('approve');
    await db.transaction((tx) => markApprovedInvitation(tx, { orgId: w.orgId, driveId: w.orgDrive, email: 'x@example.com', approvedBy: w.owner, invite: { kind: 'page', id: 'pinv_approved' } }));
    expect(await consumeApprovedInvitation(db, { driveId: w.orgDrive, invite: { kind: 'drive', id: 'dinv_other' } })).toBe(false);
    expect(await consumeApprovedInvitation(db, { driveId: w.orgDrive, invite: { kind: 'drive', id: 'pinv_approved' } })).toBe(false);
    expect(await consumeApprovedInvitation(db, { driveId: w.orgDrive, invite: { kind: 'page', id: 'pinv_never_approved' } })).toBe(false);
    expect(await consumeApprovedInvitation(db, { driveId: w.orgDrive, invite: { kind: 'page', id: 'pinv_approved' } })).toBe(true);
    expect(await consumeApprovedInvitation(db, { driveId: w.orgDrive, invite: { kind: 'page', id: 'pinv_approved' } })).toBe(false);

    await db.transaction((tx) => markApprovedInvitation(tx, { orgId: w.orgId, driveId: w.orgDrive, email: 'y@example.com', approvedBy: w.owner, invite: { kind: 'drive', id: 'dinv_y' } }));
    await setGuests('off');
    await setGuests('approve');
    expect(await consumeApprovedInvitation(db, { driveId: w.orgDrive, invite: { kind: 'drive', id: 'dinv_y' } })).toBe(false);
  });

  it('POL-2 (partial) the approval queue shows what approving will replay: the held role, custom role, token scopes and the earliest expiry', async () => {
    await setGuests('approve');
    const { drive } = await personalDriveWithOutsider();
    await db.update(driveMembers).set({ role: 'ADMIN' }).where(and(eq(driveMembers.driveId, drive), eq(driveMembers.userId, w.outsider)));
    const soon = new Date(Date.now() + 3_600_000);
    await db.update(pagePermissions).set({ expiresAt: soon }).where(eq(pagePermissions.userId, w.outsider));
    await moveDriveToOrg(w.owner, drive, { orgId: w.orgId, orgVisibility: 'RESTRICTED' }, deps);

    const { items } = await listPendingGuestApprovalViews(w.orgId, 10);
    expect(items[0].request).toEqual({ role: 'ADMIN', customRoleId: null, pageGrants: 1, tokenScopes: 1, earliestExpiry: soon.toISOString(), viaLink: false });
  });

  it('POL-2 (partial) a multi-step write that share-locks the orgs it will touch up front makes a concurrent policy change wait for it instead of deadlocking', async () => {
    let policySettled = false;
    await db.transaction(async (tx) => {
      await lockOrgsOfDrivesForShare(tx, { driveIds: [], pageIds: [w.orgPage] });
      const change = updateOrgPolicies({ orgId: w.orgId, actorId: w.owner, patch: { guests: 'off' } }).finally(() => { policySettled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(policySettled).toBe(false);
      void change;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(policySettled).toBe(true);
  });
});

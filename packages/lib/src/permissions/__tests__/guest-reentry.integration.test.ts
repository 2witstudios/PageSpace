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
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { factories } from '@pagespace/db/test/factories';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray, sql } from '@pagespace/db/operators';
import { mcpTokens, users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, driveRoles, mcpTokenDrives, pagePermissions } from '@pagespace/db/schema/members';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { pageShareLinks, driveShareLinks } from '@pagespace/db/schema/share-links';
import { completeApprovedLinkAdmission, redeemPageShareLink, redeemDriveShareLink } from '../share-link-service';
import { securityAuditLog } from '@pagespace/db/schema/security-audit';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';

vi.mock('../revocation-kick', () => ({ kickForDriveMembershipRevocation: vi.fn(async () => {}), kickForPagePermissionRevocation: vi.fn(async () => {}) }));

import { updateOrgPolicies } from '../../organizations/policies';
import { leaveOrganization } from '../../organizations/leave';
import { moveDriveToOrg, type OrgDriveServiceDeps } from '../../services/org-drive-service';
import { orgDriveServiceDeps } from '../../services/org-drive-service-deps';
import { getUserAccessLevel } from '../permissions';
import { admitReentry, claimPendingGuestApproval, consumeApprovedInvitation, holdOrgGuestsUnderPolicy, listPendingGuestApprovalViews, markApprovedInvitation, queueHeldAccess, requestGuestApproval, grantStillLive, claimGuestApprovalDecision } from '../guest-holds';
import { lockOrgsOfDrivesForShare } from '../../organizations/policy-reader';
import { completeApprovedPageGrant } from '../page-grant-admission';
import { EnforcedAuthContext } from '../enforced-context';
import type { SessionClaims } from '../../auth/session-service';
import { resetAuditDbBindingForTests } from '../../audit/audit-db-binding';
import { resetDefaultSecurityAuditForTests } from '../../audit/security-audit';
import { credentialActor } from '../access-actor';

// This app-chain suite verifies the audit records its app transactions publish.
// Dedicated Admin suites own CI's separate scratch schema and binding tests.
const AUDIT_ENV = ['ADMIN_DATABASE_URL', 'ADMIN_DB_BREAK_GLASS', 'AUDIT_TRUST_PLANE_REQUIRED'] as const;
const savedAuditEnv = new Map<string, string | undefined>();
const resetAuditBinding = () => {
  resetAuditDbBindingForTests();
  resetDefaultSecurityAuditForTests();
};
beforeAll(() => {
  for (const key of AUDIT_ENV) {
    savedAuditEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  resetAuditBinding();
});

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
    await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, created.orgIds));
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
  // [D-OW-30] an org with no subscription row is lapsed and refuses moves and new drives: this org is active.
  await factories.createOrgSubscription(orgId);
  const orgDrive = await mkDrive(owner);
  await db.update(drives).set({ orgId, orgVisibility: 'RESTRICTED' }).where(eq(drives.id, orgDrive));
  const orgPage = (await factories.createPage(orgDrive)).id;
  w = { orgId, owner, member, outsider, sharer, orgDrive, orgPage };
});

afterEach(cleanup);
afterAll(async () => {
  try {
    await cleanup();
    await pool.end();
  } finally {
    for (const [key, value] of savedAuditEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAuditBinding();
  }
});

const setGuests = async (guests: 'off' | 'approve' | 'on') => {
  const r = await updateOrgPolicies({ orgId: w.orgId, actorId: w.owner, actorAuthentication: null, patch: { guests } });
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
    expect((await getUserAccessLevel(credentialActor(w.outsider, null), page))?.canEdit).toBe(true);

    expect(await moveDriveToOrg(w.owner, drive, { orgId: w.orgId, orgVisibility: 'RESTRICTED' }, deps)).toMatchObject({ ok: true });

    expect(await getUserAccessLevel(credentialActor(w.outsider, null), page)).toBeNull();
    expect(await db.select().from(mcpTokenDrives).where(eq(mcpTokenDrives.driveId, drive))).toEqual([]);
    const [hold] = await holds('suspended');
    expect(hold.parked?.member).toMatchObject({ userId: w.outsider, driveId: drive });
    expect(hold.parked?.tokenScopes).toEqual([expect.objectContaining({ tokenId, role: 'MEMBER' })]);

    await setGuests('on');
    expect((await getUserAccessLevel(credentialActor(w.outsider, null), page))?.canEdit).toBe(true);
    expect(await db.select({ role: mcpTokenDrives.role }).from(mcpTokenDrives).where(eq(mcpTokenDrives.driveId, drive))).toEqual([{ role: 'MEMBER' }]);
  });

  it('POL-2 (partial) guests APPROVE: the outsider is queued with exactly what they held and holds nothing until approved; approving gives it back', async () => {
    await setGuests('approve');
    const { drive, page } = await personalDriveWithOutsider();
    await moveDriveToOrg(w.owner, drive, { orgId: w.orgId, orgVisibility: 'RESTRICTED' }, deps);

    expect(await getUserAccessLevel(credentialActor(w.outsider, null), page)).toBeNull();
    const [pending] = await holds('pending_approval');
    expect(pending).toMatchObject({ origin: 'page_grant', driveId: drive });
    expect(pending.request.permissions).toEqual([{ pageId: page, ...EDIT, expiresAt: null }]);

    const claim = await claimPendingGuestApproval({ orgId: w.orgId, holdId: pending.id });
    if (!claim) throw new Error('claim');
    expect(await completeApprovedPageGrant(claim)).toMatchObject({ ok: true });
    expect((await getUserAccessLevel(credentialActor(w.outsider, null), page))?.canEdit).toBe(true);
    expect(await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, drive), eq(driveMembers.userId, w.outsider)))).toHaveLength(1);
  });

  it('POL-2 (partial) guests ON: the outsider keeps their access, and org members are never held', async () => {
    await setGuests('on');
    const { drive, page } = await personalDriveWithOutsider();
    await db.insert(driveMembers).values({ driveId: drive, userId: w.member, role: 'MEMBER', acceptedAt: new Date() });
    await moveDriveToOrg(w.owner, drive, { orgId: w.orgId, orgVisibility: 'RESTRICTED' }, deps);
    expect((await getUserAccessLevel(credentialActor(w.outsider, null), page))?.canEdit).toBe(true);
    expect(await db.select().from(orgGuestHolds).where(eq(orgGuestHolds.orgId, w.orgId))).toEqual([]);
  });
});

describe('a member who leaves becomes an outsider of what they kept', () => {
  it('POL-2 (partial) X-6 (partial) guests OFF: a departed member\'s invited row and page grant are parked, not kept', async () => {
    await db.insert(driveMembers).values({ driveId: w.orgDrive, userId: w.member, role: 'MEMBER', source: 'invite', acceptedAt: new Date() });
    await db.insert(pagePermissions).values({ pageId: w.orgPage, userId: w.member, ...EDIT, grantedBy: w.owner });
    await setGuests('off');
    expect((await getUserAccessLevel(credentialActor(w.member, null), w.orgPage))?.canEdit).toBe(true);

    expect(await leaveOrganization(w.member, w.orgId)).toMatchObject({ ok: true, heldAsGuest: 1 });

    expect(await getUserAccessLevel(credentialActor(w.member, null), w.orgPage)).toBeNull();
    expect(await holds('suspended', w.member)).toHaveLength(1);
  });

  it('POL-2 (partial) guests ON: a departed member keeps an invited row as an outsider, as before', async () => {
    await setGuests('on');
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

    expect(await getUserAccessLevel(credentialActor(w.outsider, null), expiredPage)).toBeNull();
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

  it('POL-2 (partial) X-6 (partial) pages moved in under approve: an outsider holding only a page-link GUEST row on the drive is queued like any outsider; the GUEST row does not exempt them (review #2762 M2b)', async () => {
    await setGuests('approve');
    const linkGuest = w.outsider;
    // A redeemed page share link: accepted, but a GUEST holds one page, not the drive.
    await db.insert(driveMembers).values({ driveId: w.orgDrive, userId: linkGuest, role: 'GUEST', source: 'invite', acceptedAt: new Date(), invitedBy: w.owner });
    await db.insert(pagePermissions).values({ pageId: w.orgPage, userId: linkGuest, ...EDIT, grantedBy: w.owner });
    await db.transaction((tx) => holdOrgGuestsUnderPolicy(tx, { orgId: w.orgId, driveId: w.orgDrive, pageIds: [w.orgPage] }));

    expect(await db.select().from(pagePermissions).where(eq(pagePermissions.userId, linkGuest))).toEqual([]);
    expect(await holds('pending_approval', linkGuest)).toHaveLength(1);
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
      const change = updateOrgPolicies({ orgId: w.orgId, actorId: w.owner, actorAuthentication: null, patch: { guests: 'off' } }).finally(() => { policySettled = true; });
      await new Promise((r) => setTimeout(r, 300));
      expect(policySettled).toBe(false);
      void change;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(policySettled).toBe(true);
  });
});

describe('who counts as an admitted guest when access re-enters', () => {
  it('POL-2 (partial) X-6 (partial) under approve, a member upsert over a PENDING invitation row is an admission (queued), not a role change; over an accepted row it is a role change', async () => {
    await setGuests('approve');
    await db.insert(driveMembers).values({ driveId: w.orgDrive, userId: w.outsider, role: 'MEMBER', acceptedAt: null, invitedBy: w.owner });
    const upsert = () => db.transaction((tx) => admitReentry(tx, { driveId: w.orgDrive, userId: w.outsider, member: { role: 'ADMIN', acceptedAt: new Date() }, requestedBy: null, memberRowIsRoleChange: true }));
    expect(await upsert()).toMatchObject({ outcome: 'held' });
    await db.update(driveMembers).set({ acceptedAt: new Date() }).where(and(eq(driveMembers.driveId, w.orgDrive), eq(driveMembers.userId, w.outsider)));
    expect(await upsert()).toEqual({ outcome: 'admit' });
  });

  it('POL-2 (partial) a page-link GUEST row is not an admitted guest of the drive: a re-entering grant on another page is queued under approve', async () => {
    await setGuests('approve');
    await db.insert(driveMembers).values({ driveId: w.orgDrive, userId: w.outsider, role: 'GUEST', acceptedAt: new Date() });
    const outcome = await db.transaction((tx) => admitReentry(tx, { driveId: w.orgDrive, userId: w.outsider, grants: [{ pageId: w.orgPage, ...EDIT }], requestedBy: w.owner }));
    expect(outcome).toMatchObject({ outcome: 'held' });
  });
});


describe('guest approval requests preserve recipient and grant boundaries', () => {
  it('an approved page link grants only its page permissions and a GUEST row, once claimed', async () => {
    await setGuests('approve');
    const other = await factories.createPage(w.orgDrive);
    const [link] = await db.insert(pageShareLinks).values({ pageId: w.orgPage, token: createId(), createdBy: w.owner, permissions: ['VIEW', 'EDIT'] }).returning();
    const claims: SessionClaims = { sessionId: 'guest-approval', userId: w.outsider, userRole: 'user', tokenVersion: 1, adminRoleVersion: 0, type: 'user', scopes: ['*'], expiresAt: new Date(Date.now() + 3600_000) };
    const ctx = EnforcedAuthContext.fromSession(claims);
    expect(await redeemPageShareLink(ctx, link.token)).toEqual({ ok: false, error: 'PENDING_APPROVAL' });
    expect(await redeemPageShareLink(ctx, link.token)).toEqual({ ok: false, error: 'PENDING_APPROVAL' });
    const pending = (await holds('pending_approval'))[0];
    expect(await holds('pending_approval')).toHaveLength(1);
    expect((await db.select().from(pageShareLinks).where(eq(pageShareLinks.id, link.id)))[0].useCount).toBe(0);
    expect(await getUserAccessLevel(credentialActor(w.outsider, null), w.orgPage)).toBeNull();
    const claim = await claimPendingGuestApproval({ orgId: w.orgId, holdId: pending.id });
    if (!claim) throw new Error('Expected queued approval');
    expect(await completeApprovedLinkAdmission(claim)).toMatchObject({ ok: true, driveId: w.orgDrive, userId: w.outsider, role: 'GUEST', memberId: null });
    expect((await getUserAccessLevel(credentialActor(w.outsider, null), w.orgPage))?.canEdit).toBe(true);
    expect(await getUserAccessLevel(credentialActor(w.outsider, null), other.id)).toBeNull();
    expect(await db.select({ role: driveMembers.role }).from(driveMembers).where(and(eq(driveMembers.driveId, w.orgDrive), eq(driveMembers.userId, w.outsider)))).toEqual([{ role: 'GUEST' }]);
    expect((await db.select().from(pageShareLinks).where(eq(pageShareLinks.id, link.id)))[0].useCount).toBe(1);
    expect(await claimPendingGuestApproval({ orgId: w.orgId, holdId: pending.id })).toBeNull();
  });

  it('an approved legacy ADMIN drive offer discards its custom role and grants an Admin membership', async () => {
    await setGuests('approve');
    const [role] = await db.insert(driveRoles).values({ driveId: w.orgDrive, name: 'Legacy template', permissions: {} }).returning();
    const [link] = await db.insert(driveShareLinks).values({ driveId: w.orgDrive, token: createId(), createdBy: w.owner, role: 'ADMIN', customRoleId: role.id }).returning();
    const claims: SessionClaims = { sessionId: 'admin-approval', userId: w.outsider, userRole: 'user', tokenVersion: 1, adminRoleVersion: 0, type: 'user', scopes: ['*'], expiresAt: new Date(Date.now() + 3600_000) };
    expect(await redeemDriveShareLink(EnforcedAuthContext.fromSession(claims), link.token)).toEqual({ ok: false, error: 'PENDING_APPROVAL', driveId: w.orgDrive });
    const pending = (await holds('pending_approval'))[0];
    expect(pending.request).toMatchObject({ role: 'ADMIN', customRoleId: role.id });
    expect(await getUserAccessLevel(credentialActor(w.outsider, null), w.orgPage)).toBeNull();
    const claim = await claimPendingGuestApproval({ orgId: w.orgId, holdId: pending.id });
    if (!claim) throw new Error('Expected queued approval');
    expect(await completeApprovedLinkAdmission(claim)).toMatchObject({ ok: true, driveId: w.orgDrive, userId: w.outsider, role: 'ADMIN', customRoleId: null });
    expect(await db.select({ role: driveMembers.role, customRoleId: driveMembers.customRoleId }).from(driveMembers).where(and(eq(driveMembers.driveId, w.orgDrive), eq(driveMembers.userId, w.outsider)))).toEqual([{ role: 'ADMIN', customRoleId: null }]);
    expect((await getUserAccessLevel(credentialActor(w.outsider, null), w.orgPage))?.canEdit).toBe(true);
    expect((await db.select().from(driveShareLinks).where(eq(driveShareLinks.id, link.id)))[0].useCount).toBe(1);
  });

  it.each(['missing_identity', 'ambiguous_identity'] as const)('a %s request cannot create a pending guest', async invalid => {
    await expect(requestGuestApproval({ orgId: w.orgId, driveId: w.orgDrive, origin: 'invite', request: {}, requestedBy: w.owner,
      ...(invalid === 'ambiguous_identity' ? { userId: w.outsider, email: 'outsider@example.com' } : {}),
    })).rejects.toThrow('exactly one of userId or email');
    expect(await db.select().from(orgGuestHolds).where(eq(orgGuestHolds.orgId, w.orgId))).toEqual([]);
    expect(await getUserAccessLevel(credentialActor(w.outsider, null), w.orgPage)).toBeNull();
  });

  it('an emailed request normalizes identity and refreshes one queue item without granting access or inventing a requester account', async () => {
    const first = await requestGuestApproval({ orgId: w.orgId, driveId: w.orgDrive, email: '  Invitee@Example.com  ', origin: 'invite', request: { role: 'MEMBER' }, requestedBy: w.owner });
    const refreshed = await requestGuestApproval({ orgId: w.orgId, driveId: w.orgDrive, email: 'invitee@example.com', origin: 'page_link', request: { pageId: w.orgPage }, requestedBy: null });
    expect(refreshed).toMatchObject({ holdId: first.holdId, email: 'invitee@example.com', userId: null, origin: 'page_link' });
    const view = await listPendingGuestApprovalViews(w.orgId, 10);
    expect(view.total).toBe(1);
    expect(view.items).toEqual([expect.objectContaining({ holdId: first.holdId, requesterName: null,
      request: { role: null, customRoleId: null, pageGrants: 1, tokenScopes: 0, earliestExpiry: null, viaLink: true },
    })]);
    expect(await getUserAccessLevel(credentialActor(w.outsider, null), w.orgPage)).toBeNull();
  });

  it('repeated held page grants keep their union and latest expiry without creating live access, and expired-only repeats do not resurrect anything', async () => {
    await setGuests('approve');
    const soon = new Date(Date.now() + 60_000);
    const later = new Date(Date.now() + 120_000);
    const ask = (flags: typeof EDIT, expiresAt: Date | null, grantedBy = w.sharer) => queueHeldAccess(db, {
      orgId: w.orgId, driveId: w.orgDrive, userId: w.outsider, member: null,
      grants: [{ pageId: w.orgPage, ...flags, expiresAt, grantedBy }], requestedBy: w.owner,
    });
    const first = await ask(EDIT, soon);
    expect(first?.request.permissions).toEqual([{ pageId: w.orgPage, ...EDIT, expiresAt: soon.toISOString() }]);
    const sharing = { canView: true, canEdit: false, canShare: true, canDelete: false };
    const second = await ask(sharing, later, w.member);
    expect(second?.id).toBe(first?.id);
    expect(second?.request).toMatchObject({ invitedBy: w.sharer, permissions: [{ pageId: w.orgPage, canView: true, canEdit: true, canShare: true, canDelete: false, expiresAt: later.toISOString() }] });
    const deleting = { canView: false, canEdit: false, canShare: false, canDelete: true };
    const third = await ask(deleting, soon);
    expect(third?.request.permissions).toEqual([{ pageId: w.orgPage, canView: true, canEdit: true, canShare: true, canDelete: true, expiresAt: later.toISOString() }]);
    const unlimited = await ask(sharing, null);
    expect(unlimited?.request.permissions).toEqual([{ pageId: w.orgPage, canView: true, canEdit: true, canShare: true, canDelete: true, expiresAt: null }]);
    const finiteRepeat = await ask(EDIT, later);
    expect(finiteRepeat?.request.permissions).toEqual(unlimited?.request.permissions);
    expect(await ask(EDIT, new Date(0))).toBeNull();
    expect(await holds('pending_approval')).toEqual([finiteRepeat]);
    expect(await getUserAccessLevel(credentialActor(w.outsider, null), w.orgPage)).toBeNull();
    expect(await db.select().from(pagePermissions).where(eq(pagePermissions.userId, w.outsider))).toEqual([]);
  });

  it('a replacement emailed invitation approval admits only the newest offer, once', async () => {
    await markApprovedInvitation(db, { orgId: w.orgId, driveId: w.orgDrive, email: 'Person@example.com', approvedBy: w.owner, invite: { kind: 'drive', id: 'first-offer' } });
    await markApprovedInvitation(db, { orgId: w.orgId, driveId: w.orgDrive, email: ' PERSON@example.com ', approvedBy: w.owner, invite: { kind: 'page', id: 'replacement-offer' } });
    expect(await consumeApprovedInvitation(db, { driveId: w.orgDrive, invite: { kind: 'drive', id: 'first-offer' } })).toBe(false);
    expect(await consumeApprovedInvitation(db, { driveId: w.orgDrive, invite: { kind: 'page', id: 'replacement-offer' } })).toBe(true);
    expect(await consumeApprovedInvitation(db, { driveId: w.orgDrive, invite: { kind: 'page', id: 'replacement-offer' } })).toBe(false);
  });

  it('an expired-only legacy grant entering approve mode is removed rather than queued or resurrected', async () => {
    await db.insert(pagePermissions).values({ pageId: w.orgPage, userId: w.outsider, ...EDIT, grantedBy: w.owner, expiresAt: new Date(0) });
    await setGuests('approve');
    await db.transaction(tx => holdOrgGuestsUnderPolicy(tx, { orgId: w.orgId, driveId: w.orgDrive, pageIds: [w.orgPage] }));
    expect(await holds('pending_approval')).toEqual([]);
    expect(await db.select().from(pagePermissions).where(eq(pagePermissions.userId, w.outsider))).toEqual([]);
    expect(await getUserAccessLevel(credentialActor(w.outsider, null), w.orgPage)).toBeNull();
  });

  it('parking additional legacy access merges one hold and restores the original member, token and both page grants', async () => {
    await setGuests('off');
    const { drive, page, tokenId } = await personalDriveWithOutsider();
    await moveDriveToOrg(w.owner, drive, { orgId: w.orgId, orgVisibility: 'RESTRICTED' }, deps);
    const [first] = await holds('suspended');
    const extra = await factories.createPage(drive, { isPrivate: true });
    await db.insert(pagePermissions).values({ pageId: extra.id, userId: w.outsider, canView: true, canEdit: false, canShare: false, canDelete: false, grantedBy: w.owner });
    await db.transaction(tx => holdOrgGuestsUnderPolicy(tx, { orgId: w.orgId, driveId: drive }));
    const [merged] = await holds('suspended');
    expect(merged.id).toBe(first.id);
    expect(merged.parked?.member).toEqual(first.parked?.member);
    expect(merged.parked?.tokenScopes).toEqual(first.parked?.tokenScopes);
    expect(merged.parked?.grants?.map(grant => grant.pageId).sort()).toEqual([page, extra.id].sort());
    expect(await getUserAccessLevel(credentialActor(w.outsider, null), extra.id)).toBeNull();
    await setGuests('on');
    expect((await getUserAccessLevel(credentialActor(w.outsider, null), page))?.canEdit).toBe(true);
    expect(await getUserAccessLevel(credentialActor(w.outsider, null), extra.id)).toEqual({ canView: true, canEdit: false, canShare: false, canDelete: false });
    expect(await db.select({ tokenId: mcpTokenDrives.tokenId }).from(mcpTokenDrives).where(eq(mcpTokenDrives.driveId, drive))).toEqual([{ tokenId }]);
    expect(await holds('suspended')).toEqual([]);
  });

  it.each(['drive_link', 'page_link'] as const)('a claimed %s rechecks a concurrent guests-off change under the admission lock before granting access', async origin => {
    await setGuests('approve');
    const [link] = origin === 'drive_link'
      ? await db.insert(driveShareLinks).values({ driveId: w.orgDrive, token: createId(), createdBy: w.owner, role: 'MEMBER' }).returning()
      : await db.insert(pageShareLinks).values({ pageId: w.orgPage, token: createId(), createdBy: w.owner, permissions: ['VIEW'] }).returning();
    const pending = await requestGuestApproval({ orgId: w.orgId, driveId: w.orgDrive, userId: w.outsider, origin, request: { linkId: link.id }, requestedBy: w.owner });
    const claim = await claimPendingGuestApproval({ orgId: w.orgId, holdId: pending.holdId });
    if (!claim) throw new Error('Expected queued approval');
    const blocker = await pool.connect();
    let approval: ReturnType<typeof completeApprovedLinkAdmission> | undefined;
    try {
      await blocker.query('BEGIN');
      const { rows: [{ pid }] } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await blocker.query('SELECT id FROM organizations WHERE id = $1 FOR UPDATE', [w.orgId]);
      approval = completeApprovedLinkAdmission(claim);
      // Observe the admission waiting on the actual policy writer, after its
      // unlocked offer read, rather than depending on a timed delay.
      await vi.waitFor(async () => expect((await db.execute(sql`SELECT pid FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))`)).rows.length).toBeGreaterThan(0), { timeout: 3000 });
      await blocker.query('UPDATE organizations SET policies = jsonb_set(policies, $1::text[], $2::jsonb) WHERE id = $3', [['guests'], JSON.stringify('off'), w.orgId]);
      await blocker.query('COMMIT');
      expect(await approval).toEqual({ ok: false, error: 'POLICY_OFF' });
      expect(await db.select().from(driveMembers).where(eq(driveMembers.userId, w.outsider))).toEqual([]);
      expect(await db.select().from(pagePermissions).where(eq(pagePermissions.userId, w.outsider))).toEqual([]);
      const stored = origin === 'drive_link'
        ? await db.select().from(driveShareLinks).where(eq(driveShareLinks.id, link.id))
        : await db.select().from(pageShareLinks).where(eq(pageShareLinks.id, link.id));
      expect(stored[0].useCount).toBe(0);
      expect(await getUserAccessLevel(credentialActor(w.outsider, null), w.orgPage)).toBeNull();
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled([approval]);
    }
  }, 10000);

  it('member-only and token-only held requests retain their template and requester while granting no drive access', async () => {
    await setGuests('approve');
    const [requester] = await db.select({ name: users.name }).from(users).where(eq(users.id, w.outsider));
    const [role] = await db.insert(driveRoles).values({ driveId: w.orgDrive, name: 'Held template', permissions: {} }).returning();
    const first = await queueHeldAccess(db, { orgId: w.orgId, driveId: w.orgDrive, userId: w.outsider,
      member: { role: 'MEMBER', customRoleId: role.id }, grants: [], requestedBy: w.owner });
    const [token] = await db.insert(mcpTokens).values({ userId: w.outsider, tokenHash: createId(), tokenPrefix: 'mcp_held', name: 'Held credential' }).returning();
    const second = await queueHeldAccess(db, { orgId: w.orgId, driveId: w.orgDrive, userId: w.outsider,
      member: null, grants: [], tokenScopes: [{ tokenId: token.id, role: 'MEMBER', customRoleId: role.id }], requestedBy: w.sharer });
    expect(second?.id).toBe(first?.id);
    expect(second?.request).toMatchObject({ invitedBy: w.owner, member: { role: 'MEMBER', customRoleId: role.id }, permissions: [], tokenScopes: [{ tokenId: token.id, role: 'MEMBER', customRoleId: role.id }] });
    const view = await listPendingGuestApprovalViews(w.orgId, 10);
    expect(view.items).toEqual([expect.objectContaining({ requesterName: requester.name,
      request: { role: 'MEMBER', customRoleId: role.id, pageGrants: 0, tokenScopes: 1, earliestExpiry: null, viaLink: false },
    })]);
    expect(await getUserAccessLevel(credentialActor(w.outsider, null), w.orgPage)).toBeNull();
    expect(await db.select().from(driveMembers).where(eq(driveMembers.userId, w.outsider))).toEqual([]);
    expect(await db.select().from(mcpTokenDrives).where(eq(mcpTokenDrives.tokenId, token.id))).toEqual([]);
  });

  it('declining an emailed guest removes only that request and audits an email target without exposing the address or inventing an account', async () => {
    const email = 'private-invitee@example.com';
    const pending = await requestGuestApproval({ orgId: w.orgId, driveId: w.orgDrive, email, origin: 'invite', request: { role: 'MEMBER' }, requestedBy: w.owner });
    expect(await claimGuestApprovalDecision({ orgId: w.orgId, holdId: pending.holdId, decision: 'decline', actorId: w.owner })).toMatchObject({ ok: true, claim: { userId: null, email } });
    expect(await claimGuestApprovalDecision({ orgId: w.orgId, holdId: pending.holdId, decision: 'decline', actorId: w.owner })).toEqual({ ok: false, reason: 'not_found' });
    const events = await db.select().from(securityAuditLog).where(and(eq(securityAuditLog.eventType, 'org.guest.declined'), eq(securityAuditLog.resourceId, w.orgDrive)));
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ holdId: pending.holdId, origin: 'invite', target: 'email' });
    expect(events[0].details).not.toHaveProperty('targetUserId');
    expect(JSON.stringify(events[0].details)).not.toContain(email);
    expect(await db.select().from(orgGuestHolds).where(eq(orgGuestHolds.orgId, w.orgId))).toEqual([]);
    expect(await getUserAccessLevel(credentialActor(w.outsider, null), w.orgPage)).toBeNull();
  });

  it.each(['drive_link', 'page_link'] as const)('a lapsed org member cannot acquire new access from an existing %s despite retaining org membership', async origin => {
    const [link] = origin === 'drive_link'
      ? await db.insert(driveShareLinks).values({ driveId: w.orgDrive, token: createId(), createdBy: w.owner, role: 'MEMBER' }).returning()
      : await db.insert(pageShareLinks).values({ pageId: w.orgPage, token: createId(), createdBy: w.owner, permissions: ['VIEW'] }).returning();
    await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
    const claims: SessionClaims = { sessionId: 'lapsed-member', userId: w.member, userRole: 'user', tokenVersion: 1, adminRoleVersion: 0, type: 'user', scopes: ['*'], expiresAt: new Date(Date.now() + 3600_000) };
    const ctx = EnforcedAuthContext.fromSession(claims);
    const result = origin === 'drive_link' ? await redeemDriveShareLink(ctx, link.token) : await redeemPageShareLink(ctx, link.token);
    expect(result).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, w.orgId), eq(orgMembers.userId, w.member)))).toHaveLength(1);
    expect(await db.select().from(driveMembers).where(eq(driveMembers.userId, w.member))).toEqual([]);
    expect(await db.select().from(pagePermissions).where(eq(pagePermissions.userId, w.member))).toEqual([]);
    const stored = origin === 'drive_link' ? await db.select().from(driveShareLinks).where(eq(driveShareLinks.id, link.id)) : await db.select().from(pageShareLinks).where(eq(pageShareLinks.id, link.id));
    expect(stored[0].useCount).toBe(0);
    expect(await getUserAccessLevel(credentialActor(w.member, null), w.orgPage)).toBeNull();
  });

  it('expiry at the admission instant gives no access, while a future ISO expiry or no expiry still does', () => {
    const now = new Date('2026-10-13T20:00:00Z');
    expect(grantStillLive(now, now)).toBe(false);
    expect(grantStillLive('2026-10-13T20:00:00Z', now)).toBe(false);
    expect(grantStillLive('2026-10-13T20:00:01Z', now)).toBe(true);
    expect(grantStillLive(null, now)).toBe(true);
  });
});

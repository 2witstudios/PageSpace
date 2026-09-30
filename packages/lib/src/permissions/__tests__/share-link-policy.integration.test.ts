/**
 * Public share links under the org policy — REAL Postgres (Spec POL-3, X-6).
 *
 * Off means: no new link is created, a link that already exists is SUSPENDED (not deleted) and cannot be
 * redeemed or even previewed, and the refusal is indistinguishable from a link that does not exist. The
 * redeem path checks the live policy AND the marker, so neither a missing marker nor a stale one can let a
 * link through. Turning the policy back on restores the links.
 *
 * Locally:
 *     DATABASE_URL=... bun run --filter '@pagespace/lib' test:integration -- src/permissions/__tests__/share-link-policy.integration.test.ts
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
import { driveShareLinks, pageShareLinks } from '@pagespace/db/schema/share-links';
import type { SessionClaims } from '../../auth/session-service';
import { EnforcedAuthContext } from '../enforced-context';
import { completeApprovedLinkAdmission, createDriveShareLink, createPageShareLink, redeemDriveShareLink, redeemPageShareLink, resolveShareToken } from '../share-link-service';
import { claimPendingGuestApproval, listPendingGuestApprovals } from '../guest-holds';
import { getUserAccessLevel } from '../permissions';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('../../audit/org-audit', () => ({ recordOrgAuditEvent: vi.fn(async () => {}) }));

import { updateOrgPolicies } from '../../organizations/policies';

const run = createId().slice(0, 8);
const created = { userIds: [] as string[], driveIds: [] as string[], orgIds: [] as string[] };

const ctxFor = (userId: string): EnforcedAuthContext => {
  const claims: SessionClaims = {
    sessionId: 'sess', userId, userRole: 'user', tokenVersion: 1, adminRoleVersion: 0, type: 'user', scopes: ['*'],
    expiresAt: new Date(Date.now() + 3_600_000), driveId: undefined,
  };
  return EnforcedAuthContext.fromSession(claims);
};

interface World {
  orgId: string;
  owner: string;
  outsider: string;
  orgDrive: string;
  orgPage: string;
  personalDrive: string;
  personalPage: string;
  otherOrg: string;
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
  const mkUser = async () => {
    const u = await factories.createUser();
    created.userIds.push(u.id);
    return u.id;
  };
  const [owner, outsider, otherOwner] = [await mkUser(), await mkUser(), await mkUser()];
  const orgId = createId();
  const otherOrg = createId();
  created.orgIds.push(orgId, otherOrg);
  await db.insert(organizations).values([
    { id: orgId, name: 'Northwind', slug: `nw-${run}-${createId().slice(0, 4)}`, ownerId: owner },
    { id: otherOrg, name: 'Other', slug: `ot-${run}-${createId().slice(0, 4)}`, ownerId: otherOwner },
  ]);
  await db.insert(orgMembers).values([
    { orgId, userId: owner, role: 'OWNER' },
    { orgId: otherOrg, userId: otherOwner, role: 'OWNER' },
  ]);
  const mkDrive = async (ownerId: string, org: string | null) => {
    const d = await factories.createDrive(ownerId);
    created.driveIds.push(d.id);
    if (org) await db.update(drives).set({ orgId: org, orgVisibility: 'OPEN' }).where(eq(drives.id, d.id));
    return d.id;
  };
  const orgDrive = await mkDrive(owner, orgId);
  const personalDrive = await mkDrive(outsider, null);
  const orgPage = (await factories.createPage(orgDrive, { isPrivate: false })).id;
  const personalPage = (await factories.createPage(personalDrive, { isPrivate: false })).id;
  w = { orgId, owner, outsider, orgDrive, orgPage, personalDrive, personalPage, otherOrg };
});

afterEach(cleanup);
afterAll(async () => {
  await cleanup();
  await pool.end();
});

const off = () => updateOrgPolicies({ orgId: w.orgId, actorId: w.owner, patch: { publicShareLinks: false } });
const on = () => updateOrgPolicies({ orgId: w.orgId, actorId: w.owner, patch: { publicShareLinks: true } });
const newUser = async () => {
  const u = await factories.createUser();
  created.userIds.push(u.id);
  return u.id;
};

async function makeLinks() {
  const drive = await createDriveShareLink(ctxFor(w.owner), w.orgDrive, {});
  const page = await createPageShareLink(ctxFor(w.owner), w.orgPage, { permissions: ['VIEW'] });
  if (!drive.ok || !page.ok) throw new Error('setup: links should be creatable while the policy is on');
  return { drive: drive.data, page: page.data };
}

describe('creation', () => {
  it('POL-3 with public share links ON both link kinds are created; OFF refuses both, naming the policy, and stores nothing', async () => {
    await makeLinks();
    await off();

    const drive = await createDriveShareLink(ctxFor(w.owner), w.orgDrive, {});
    const page = await createPageShareLink(ctxFor(w.owner), w.orgPage, { permissions: ['VIEW'] });

    expect(drive).toMatchObject({ ok: false, error: 'POLICY_FORBIDDEN', message: expect.stringContaining('share links') });
    expect(page).toMatchObject({ ok: false, error: 'POLICY_FORBIDDEN' });
    expect(await db.$count(driveShareLinks, eq(driveShareLinks.driveId, w.orgDrive))).toBe(1);
    expect(await db.$count(pageShareLinks, eq(pageShareLinks.pageId, w.orgPage))).toBe(1);
  });

  it('POL-3 (partial) X-6 (partial) the policy binds the org that set it only: a personal drive and another org still create links', async () => {
    await off();
    expect((await createDriveShareLink(ctxFor(w.outsider), w.personalDrive, {})).ok).toBe(true);
    expect((await createPageShareLink(ctxFor(w.outsider), w.personalPage, { permissions: ['VIEW'] })).ok).toBe(true);
  });
});

describe('redemption and preview', () => {
  it('POL-3 X-6 (partial) a link that existed when the policy went off is refused exactly like a missing link: no membership, no grant, no preview, no use counted', async () => {
    const { drive, page } = await makeLinks();
    await off();

    const redeemer = await newUser();
    const before = await db.$count(driveMembers, eq(driveMembers.driveId, w.orgDrive));
    const missing = await redeemDriveShareLink(ctxFor(redeemer), 'ps_share_does_not_exist');
    const driveResult = await redeemDriveShareLink(ctxFor(redeemer), drive.rawToken);
    const pageResult = await redeemPageShareLink(ctxFor(redeemer), page.rawToken);

    expect(driveResult).toEqual(missing);
    expect(pageResult).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(await db.$count(driveMembers, eq(driveMembers.driveId, w.orgDrive))).toBe(before);
    expect(await db.$count(pagePermissions, eq(pagePermissions.userId, redeemer))).toBe(0);
    expect(await resolveShareToken(drive.rawToken)).toBeNull();
    expect(await resolveShareToken(page.rawToken)).toBeNull();
    const [row] = await db.select({ n: driveShareLinks.useCount }).from(driveShareLinks).where(eq(driveShareLinks.id, drive.id));
    expect(row.n).toBe(0);
  });

  it('POL-3 (partial) suspension is checked at redemption by the LIVE policy, not only the marker: a link whose marker is missing is still refused while the policy is off', async () => {
    const { drive } = await makeLinks();
    await off();
    await db.update(driveShareLinks).set({ suspendedByPolicy: null }).where(eq(driveShareLinks.id, drive.id));

    expect(await redeemDriveShareLink(ctxFor(await newUser()), drive.rawToken)).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('POL-3 (partial) and by the MARKER, not only the live policy: a marked link is refused even with the policy on', async () => {
    const { drive, page } = await makeLinks();
    await db.update(driveShareLinks).set({ suspendedByPolicy: 'publicShareLinks' }).where(eq(driveShareLinks.id, drive.id));
    await db.update(pageShareLinks).set({ suspendedByPolicy: 'publicShareLinks' }).where(eq(pageShareLinks.id, page.id));

    expect(await redeemDriveShareLink(ctxFor(await newUser()), drive.rawToken)).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(await redeemPageShareLink(ctxFor(await newUser()), page.rawToken)).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(await resolveShareToken(drive.rawToken)).toBeNull();
  });

  it('POL-3 (partial) turning the policy back on restores the links: both redeem again and the preview shows', async () => {
    const { drive, page } = await makeLinks();
    await off();
    await on();

    expect(await resolveShareToken(drive.rawToken)).toMatchObject({ type: 'drive', driveId: w.orgDrive });
    expect((await redeemDriveShareLink(ctxFor(await newUser()), drive.rawToken)).ok).toBe(true);
    expect((await redeemPageShareLink(ctxFor(await newUser()), page.rawToken)).ok).toBe(true);
  });

  it('POL-3 (partial) a link deactivated while suspended stays unusable after the policy is turned back on', async () => {
    const { drive } = await makeLinks();
    await off();
    await db.update(driveShareLinks).set({ isActive: false }).where(eq(driveShareLinks.id, drive.id));
    await on();

    expect(await redeemDriveShareLink(ctxFor(await newUser()), drive.rawToken)).toEqual({ ok: false, error: 'NOT_FOUND' });
  });

  it('POL-3 (partial) another org turning its links off changes nothing here', async () => {
    const { drive } = await makeLinks();
    await updateOrgPolicies({ orgId: w.otherOrg, actorId: (await db.select({ o: organizations.ownerId }).from(organizations).where(eq(organizations.id, w.otherOrg)))[0].o, patch: { publicShareLinks: false } });

    expect((await redeemDriveShareLink(ctxFor(await newUser()), drive.rawToken)).ok).toBe(true);
    const members = await db.select().from(driveMembers).where(and(eq(driveMembers.driveId, w.orgDrive)));
    expect(members.length).toBeGreaterThan(0);
  });
});

describe('guests policy at redemption', () => {
  const setGuests = (guests: 'off' | 'approve' | 'on') => updateOrgPolicies({ orgId: w.orgId, actorId: w.owner, patch: { guests } });
  const orgMemberUser = async () => {
    const id = await newUser();
    await db.insert(orgMembers).values({ orgId: w.orgId, userId: id, role: 'MEMBER' });
    return id;
  };
  const memberRow = (userId: string) => db.select().from(driveMembers).where(and(eq(driveMembers.driveId, w.orgDrive), eq(driveMembers.userId, userId)));

  it('POL-2 X-6 (partial) guests OFF: an outsider redeeming either link kind is refused like a missing link and nothing is created', async () => {
    const { drive, page } = await makeLinks();
    await setGuests('off');
    const outsider = await newUser();

    expect(await redeemDriveShareLink(ctxFor(outsider), drive.rawToken)).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(await redeemPageShareLink(ctxFor(outsider), page.rawToken)).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(await memberRow(outsider)).toEqual([]);
    expect(await db.$count(pagePermissions, eq(pagePermissions.userId, outsider))).toBe(0);
    expect((await listPendingGuestApprovals(w.orgId, 10)).total).toBe(0);
  });

  it('POL-2 (partial) guests OFF does not stop an org MEMBER redeeming: they are not a guest', async () => {
    const { page } = await makeLinks();
    await setGuests('off');
    expect((await redeemPageShareLink(ctxFor(await orgMemberUser()), page.rawToken)).ok).toBe(true);
  });

  it('POL-2 guests APPROVE: the outsider is queued, told so, and holds NO access — no row, no grant, no page access', async () => {
    const { drive, page } = await makeLinks();
    await setGuests('approve');
    const outsider = await newUser();

    expect(await redeemDriveShareLink(ctxFor(outsider), drive.rawToken)).toEqual({ ok: false, error: 'PENDING_APPROVAL', driveId: w.orgDrive });
    expect(await redeemPageShareLink(ctxFor(outsider), page.rawToken)).toEqual({ ok: false, error: 'PENDING_APPROVAL' });

    expect(await memberRow(outsider)).toEqual([]);
    expect(await getUserAccessLevel(outsider, w.orgPage)).toBeNull();
    const queue = await listPendingGuestApprovals(w.orgId, 10);
    // One queue row per person and drive: the page request refreshes the drive request (the later one wins).
    expect(queue.total).toBe(1);
    expect(queue.items[0]).toMatchObject({ userId: outsider, driveId: w.orgDrive });
  });

  it('POL-2 (partial) approving a queued DRIVE-link redeemer admits them with the link\'s role; a queued PAGE-link redeemer becomes a GUEST with the page grant', async () => {
    const { drive, page } = await makeLinks();
    await setGuests('approve');
    const driveGuest = await newUser();
    await redeemDriveShareLink(ctxFor(driveGuest), drive.rawToken);
    const claimedDrive = await claimPendingGuestApproval({ orgId: w.orgId, holdId: (await listPendingGuestApprovals(w.orgId, 10)).items[0].holdId });
    if (!claimedDrive) throw new Error('expected a queued request');

    const admitted = await completeApprovedLinkAdmission(claimedDrive);
    expect(admitted).toMatchObject({ ok: true, userId: driveGuest, driveId: w.orgDrive, role: 'MEMBER' });
    expect((await memberRow(driveGuest))[0]).toMatchObject({ role: 'MEMBER' });

    const pageGuest = await newUser();
    await redeemPageShareLink(ctxFor(pageGuest), page.rawToken);
    const claimedPage = await claimPendingGuestApproval({ orgId: w.orgId, holdId: (await listPendingGuestApprovals(w.orgId, 10)).items[0].holdId });
    if (!claimedPage) throw new Error('expected a queued request');
    expect(await completeApprovedLinkAdmission(claimedPage)).toMatchObject({ ok: true, role: 'GUEST' });
    expect((await memberRow(pageGuest))[0].role).toBe('GUEST');
    expect((await getUserAccessLevel(pageGuest, w.orgPage))?.canView).toBe(true);
  });

  it('POL-2 (partial) approval re-checks the offer and the policy: a link revoked meanwhile, or guests turned OFF meanwhile, admits no one', async () => {
    const { drive } = await makeLinks();
    await setGuests('approve');
    const a = await newUser();
    const b = await newUser();
    await redeemDriveShareLink(ctxFor(a), drive.rawToken);
    await redeemDriveShareLink(ctxFor(b), drive.rawToken);
    const [first, second] = (await listPendingGuestApprovals(w.orgId, 10)).items;
    const claim = async (id: string) => {
      const c = await claimPendingGuestApproval({ orgId: w.orgId, holdId: id });
      if (!c) throw new Error('expected a queued request');
      return c;
    };

    await db.update(driveShareLinks).set({ isActive: false }).where(eq(driveShareLinks.id, drive.id));
    expect(await completeApprovedLinkAdmission(await claim(first.holdId))).toEqual({ ok: false, error: 'LINK_GONE' });

    await db.update(driveShareLinks).set({ isActive: true }).where(eq(driveShareLinks.id, drive.id));
    await setGuests('off');
    expect(await completeApprovedLinkAdmission(await claim(second.holdId))).toEqual({ ok: false, error: 'POLICY_OFF' });
    expect(await memberRow(a)).toEqual([]);
    expect(await memberRow(b)).toEqual([]);
  });

  it('POL-2 guests ON admits an outsider at once, as before', async () => {
    const { drive } = await makeLinks();
    expect((await redeemDriveShareLink(ctxFor(await newUser()), drive.rawToken)).ok).toBe(true);
  });

  it('POL-2 (partial) a drive link to a PERSONAL drive is never held: no org, no guest policy', async () => {
    const link = await createDriveShareLink(ctxFor(w.outsider), w.personalDrive, {});
    if (!link.ok) throw new Error('setup');
    await setGuests('off');
    expect((await redeemDriveShareLink(ctxFor(await newUser()), link.data.rawToken)).ok).toBe(true);
  });
});

/**
 * [D-OW-33] against a real Postgres: billing never blocks security. While an org is LAPSED its Owner
 * and Admins may still make every RESTRICTING change — turn guests off (outsiders are parked), tighten
 * sharing and policies, remove members, revoke share links and invitations, decline guest requests,
 * pause a drive wallet, lower a cap — and every change that loosens access or adds spend is refused
 * with the lapse refusal (SEAT-9) until the org pays.
 *
 * Northwind Labs (Sequence Spec Part 2): Jono Owner, Priya Admin, Dana member and Product's lead,
 * Marcus member of Product, Gita an outsider guest in Product. ORGS_ENABLED on. Deletes every row it
 * creates, children before parents, users last, and ends the pool.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import type { SessionClaims } from '../../auth/session-service';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';
import { organizations, orgInvitations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { driveShareLinks } from '@pagespace/db/schema/share-links';
import { walletConsumerCaps, wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';

vi.mock('../orgs-enabled', () => ({ ORGS_ENABLED: true }));
// The org audit chain is a separate store this suite does not assert; nothing may be left in it.
vi.mock('../../audit/org-audit', () => ({
  recordOrgAuditEvent: vi.fn(async () => {}),
  recordOrgAuditEventAfterCommit: vi.fn(async () => true),
}));

import { getOrgPolicies, updateOrgPolicies } from '../policies';
import { DEFAULT_ORG_POLICIES } from '../policies-core';
import { ORG_LAPSED_MESSAGE, isOrgActive } from '../status';
import { removeMember } from '../membership';
import { revokeInvitation } from '../invitations';
import { claimGuestApprovalDecision, claimPendingGuestApproval, requestGuestApproval } from '../../permissions/guest-holds';
import { revokeDriveShareLink } from '../../permissions/share-link-service';
import { EnforcedAuthContext } from '../../permissions/enforced-context';
import { getUserAccessLevel } from '../../permissions/permissions';
import { setDriveWalletCap, setSeatCap, updateDriveWallet } from '../../services/drive-wallet-service';

interface World {
  orgId: string;
  productId: string;
  pageId: string;
  poolId: string;
  productWalletId: string;
  linkId: string;
  inviteId: string;
  ids: Record<'jono' | 'priya' | 'dana' | 'marcus' | 'gita' | 'omar', string>;
  userIds: string[];
}

let dbAvailable = false;
let world: World | null = null;
const originalMode = process.env.DEPLOYMENT_MODE;

const ctxFor = (userId: string): EnforcedAuthContext => {
  const claims: SessionClaims = {
    sessionId: 'sess', userId, userRole: 'user', tokenVersion: 1, adminRoleVersion: 0, type: 'user', scopes: ['*'],
    expiresAt: new Date(Date.now() + 3_600_000), driveId: undefined,
  };
  return EnforcedAuthContext.fromSession(claims);
};

/** The webhook's mirror, written directly: the org's subscription as Stripe last reported it. */
async function setSubscription(orgId: string, status: string): Promise<void> {
  await factories.createOrgSubscription(orgId, { status }).catch(async () => {
    await db.update(orgSubscriptions).set({ status }).where(eq(orgSubscriptions.orgId, orgId));
  });
}

async function build(): Promise<World> {
  const make = (name: string) => factories.createUser({ name, subscriptionTier: 'free', email: `${name.split(' ')[0].toLowerCase()}-${createId()}@northwind.test` });
  const [jono, priya, dana, marcus, gita, omar] = await Promise.all(['Jono', 'Priya Nair', 'Dana Kim', 'Marcus Oyelaran', 'Gita Outside', 'Omar Requester'].map(make));
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id }).returning();
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: priya.id, role: 'ADMIN' },
    { orgId: org.id, userId: dana.id, role: 'MEMBER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(dana.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
  const page = await factories.createPage(product.id, { title: 'Roadmap' });
  // Gita is an outsider guest of Product: a MEMBER-role invite with a view grant on the page.
  await db.insert(driveMembers).values({ driveId: product.id, userId: gita.id, role: 'MEMBER', acceptedAt: new Date(), invitedBy: dana.id });
  await db.insert(pagePermissions).values({ pageId: page.id, userId: gita.id, canView: true, canEdit: false, canShare: false, canDelete: false, grantedBy: dana.id });
  const [link] = await db.insert(driveShareLinks).values({ driveId: product.id, token: createId(), createdBy: dana.id }).returning({ id: driveShareLinks.id });
  const [invite] = await db
    .insert(orgInvitations)
    .values({ orgId: org.id, email: `lena-${createId()}@northwind.test`, role: 'MEMBER', invitedBy: priya.id, tokenHash: createId(), expiresAt: new Date(Date.now() + 7 * 86_400_000) })
    .returning({ id: orgInvitations.id });

  const [poolWallet] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 900_000 }).returning();
  const [productWallet] = await db
    .insert(wallets)
    .values({ ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: product.id, parentWalletId: poolWallet.id, monthlyAllowanceCents: 120_000, monthlyPeriodStart: new Date(Date.now() - 86_400_000) })
    .returning();

  // Northwind paid (D-OW-30); each test lapses it.
  await setSubscription(org.id, 'active');
  const ids = { jono: jono.id, priya: priya.id, dana: dana.id, marcus: marcus.id, gita: gita.id, omar: omar.id };
  return {
    orgId: org.id, productId: product.id, pageId: page.id, poolId: poolWallet.id, productWalletId: productWallet.id,
    linkId: link.id, inviteId: invite.id, ids, userIds: Object.values(ids),
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(walletConsumerCaps).where(inArray(walletConsumerCaps.walletId, [w.poolId, w.productWalletId]));
  await db.delete(wallets).where(eq(wallets.parentWalletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(orgGuestHolds).where(eq(orgGuestHolds.orgId, w.orgId));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  const owned = (await db.select({ id: drives.id }).from(drives).where(inArray(drives.ownerId, w.userIds))).map((d) => d.id);
  const driveIds = [...new Set([w.productId, ...owned])];
  await db.delete(driveShareLinks).where(inArray(driveShareLinks.driveId, driveIds));
  await db.delete(pagePermissions).where(inArray(pagePermissions.userId, w.userIds));
  await db.delete(pages).where(inArray(pages.driveId, driveIds));
  await db.delete(driveMembers).where(inArray(driveMembers.driveId, driveIds));
  await db.delete(drives).where(inArray(drives.id, driveIds));
  await db.delete(orgInvitations).where(eq(orgInvitations.orgId, w.orgId));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const lapsedPolicyRefusal = { ok: false, reason: 'org_lapsed', message: ORG_LAPSED_MESSAGE };
const lapsedWalletRefusal = { ok: false, status: 402, code: 'org_lapsed', message: ORG_LAPSED_MESSAGE };
const capOf = async (walletId: string, userId: string) =>
  (await db.select({ daily: walletConsumerCaps.dailyCapCents, monthly: walletConsumerCaps.monthlyCapCents }).from(walletConsumerCaps)
    .where(and(eq(walletConsumerCaps.walletId, walletId), eq(walletConsumerCaps.consumerKey, `user:${userId}`))))[0] ?? null;

describe('a lapsed org may still restrict (orgs on, real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('lapsed-restrict.integration.test.ts', error);
    }
  });

  beforeEach(async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    if (dbAvailable) world = await build();
  });

  afterEach(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (world) await teardown(world);
    world = null;
  });

  afterAll(async () => { await pool.end(); });

  it('SEAT-9 (partial) POL-2 (partial) while lapsed an Admin turns guests off: it is stored and the outsider is PARKED; turning them back on is refused and stores nothing; paid again, on goes through and the guest returns', async () => {
    if (!world) return;
    const w = world;
    expect((await getUserAccessLevel(w.ids.gita, w.pageId))?.canView).toBe(true);
    await setSubscription(w.orgId, 'canceled');
    expect(await isOrgActive(w.orgId)).toBe(false);

    const off = await updateOrgPolicies({ orgId: w.orgId, actorId: w.ids.priya, patch: { guests: 'off' } });
    expect(off).toMatchObject({ ok: true, policies: { guests: 'off' } });
    expect((await getOrgPolicies(w.orgId)).guests).toBe('off');
    expect(await getUserAccessLevel(w.ids.gita, w.pageId)).toBeNull();

    for (const guests of ['approve', 'on'] as const) {
      expect(await updateOrgPolicies({ orgId: w.orgId, actorId: w.ids.priya, patch: { guests } })).toEqual(lapsedPolicyRefusal);
      expect((await getOrgPolicies(w.orgId)).guests).toBe('off');
      expect(await getUserAccessLevel(w.ids.gita, w.pageId)).toBeNull();
    }

    await setSubscription(w.orgId, 'active');
    expect(await updateOrgPolicies({ orgId: w.orgId, actorId: w.ids.priya, patch: { guests: 'on' } })).toMatchObject({ ok: true, policies: { guests: 'on' } });
    expect((await getUserAccessLevel(w.ids.gita, w.pageId))?.canView).toBe(true);
  });

  it('SEAT-9 (partial) POL-1 (partial) while lapsed a batch of restrictions applies (share links suspended); a MIXED change is refused whole and stores nothing', async () => {
    if (!world) return;
    const w = world;
    await setSubscription(w.orgId, 'unpaid');

    const mixed = await updateOrgPolicies({ orgId: w.orgId, actorId: w.ids.priya, patch: { guests: 'off', seatAllowanceCents: DEFAULT_ORG_POLICIES.seatAllowanceCents + 1 } });
    expect(mixed).toEqual(lapsedPolicyRefusal);
    expect(await getOrgPolicies(w.orgId)).toEqual(DEFAULT_ORG_POLICIES);
    expect((await getUserAccessLevel(w.ids.gita, w.pageId))?.canView).toBe(true);

    const tightened = await updateOrgPolicies({
      orgId: w.orgId,
      actorId: w.ids.priya,
      patch: { publicShareLinks: false, publishWeb: false, seatAllowanceCents: 0, modelAllowlist: ['anthropic/claude'], cloudSandbox: false, whoCanCreateDrives: 'admins' },
    });
    expect(tightened).toMatchObject({ ok: true });
    const [link] = await db.select({ suspended: driveShareLinks.suspendedByPolicy }).from(driveShareLinks).where(eq(driveShareLinks.id, w.linkId));
    expect(link.suspended).not.toBeNull();
    // Loosening any one of them back is refused while lapsed.
    expect(await updateOrgPolicies({ orgId: w.orgId, actorId: w.ids.priya, patch: { publicShareLinks: true } })).toEqual(lapsedPolicyRefusal);
    expect((await getOrgPolicies(w.orgId)).publicShareLinks).toBe(false);
  });

  it('SEAT-9 (partial) while lapsed an Admin can remove a member, revoke a share link, revoke an invitation and decline a guest request', async () => {
    if (!world) return;
    const w = world;
    const hold = await requestGuestApproval({ orgId: w.orgId, driveId: w.productId, userId: w.ids.omar, origin: 'invite', request: { role: 'MEMBER' }, requestedBy: w.ids.dana });
    await setSubscription(w.orgId, 'canceled');
    expect(await isOrgActive(w.orgId)).toBe(false);

    expect(await removeMember({ orgId: w.orgId, actorId: w.ids.priya, targetId: w.ids.marcus })).toMatchObject({ ok: true });
    expect(await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, w.orgId), eq(orgMembers.userId, w.ids.marcus)))).toHaveLength(0);

    expect(await revokeDriveShareLink(ctxFor(w.ids.dana), w.linkId)).toEqual({ ok: true, data: undefined });
    expect((await db.select({ active: driveShareLinks.isActive }).from(driveShareLinks).where(eq(driveShareLinks.id, w.linkId)))[0].active).toBe(false);

    expect(await revokeInvitation({ orgId: w.orgId, invitationId: w.inviteId, actorId: w.ids.priya })).toBe(true);
    expect(await db.select().from(orgInvitations).where(eq(orgInvitations.id, w.inviteId))).toHaveLength(0);

    // Declining is the claim the route takes before it records the decline: the request leaves the queue.
    expect(await claimPendingGuestApproval({ orgId: w.orgId, holdId: hold.holdId })).toMatchObject({ holdId: hold.holdId, userId: w.ids.omar });
    expect(await db.select().from(orgGuestHolds).where(eq(orgGuestHolds.id, hold.holdId))).toHaveLength(0);
  });

  it('SEAT-9 (partial) POL-2 (partial) while lapsed an Admin can DECLINE a guest request but not APPROVE one (it admits an outsider): approve is refused org_lapsed and the request stays queued (review #2817 P3-1)', async () => {
    if (!world) return;
    const w = world;
    const hold = await requestGuestApproval({ orgId: w.orgId, driveId: w.productId, userId: w.ids.omar, origin: 'invite', request: { role: 'MEMBER' }, requestedBy: w.ids.dana });
    await setSubscription(w.orgId, 'canceled');

    expect(await claimGuestApprovalDecision({ orgId: w.orgId, holdId: hold.holdId, decision: 'approve' })).toEqual(lapsedPolicyRefusal);
    expect(await db.select({ id: orgGuestHolds.id }).from(orgGuestHolds).where(eq(orgGuestHolds.id, hold.holdId))).toHaveLength(1);

    // Paid again, the same request can be approved: it is claimed off the queue for the invite handlers to admit.
    await setSubscription(w.orgId, 'active');
    expect(await claimGuestApprovalDecision({ orgId: w.orgId, holdId: hold.holdId, decision: 'approve' })).toMatchObject({ ok: true, claim: { holdId: hold.holdId, userId: w.ids.omar } });

    // Declining needs no paid org.
    const second = await requestGuestApproval({ orgId: w.orgId, driveId: w.productId, userId: w.ids.gita, origin: 'invite', request: { role: 'MEMBER' }, requestedBy: w.ids.dana });
    await setSubscription(w.orgId, 'unpaid');
    expect(await claimGuestApprovalDecision({ orgId: w.orgId, holdId: second.holdId, decision: 'decline' })).toMatchObject({ ok: true, claim: { holdId: second.holdId } });
    expect(await claimGuestApprovalDecision({ orgId: w.orgId, holdId: 'nope', decision: 'decline' })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('SEAT-9 (partial) WAL-7 (partial) while lapsed a drive wallet can be PAUSED (the kill switch) but not resumed; money-moving writes stay refused', async () => {
    if (!world) return;
    const w = world;
    await setSubscription(w.orgId, 'unpaid');

    expect(await updateDriveWallet(w.ids.priya, w.productId, { paused: true, allocationCents: 1 }, 'session')).toEqual(lapsedWalletRefusal);
    expect((await db.select({ status: wallets.status }).from(wallets).where(eq(wallets.id, w.productWalletId)))[0].status).toBe('active');

    expect(await updateDriveWallet(w.ids.priya, w.productId, { paused: true }, 'session')).toMatchObject({ ok: true });
    expect((await db.select({ status: wallets.status }).from(wallets).where(eq(wallets.id, w.productWalletId)))[0].status).toBe('paused');
    expect(await updateDriveWallet(w.ids.priya, w.productId, { fallbackRule: 'refuse', donationsEnabled: false }, 'session')).toMatchObject({ ok: true });

    expect(await updateDriveWallet(w.ids.priya, w.productId, { paused: false }, 'session')).toEqual(lapsedWalletRefusal);
    expect(await updateDriveWallet(w.ids.priya, w.productId, { allocationCents: 1 }, 'session')).toEqual(lapsedWalletRefusal);
    expect(await updateDriveWallet(w.ids.priya, w.productId, { fallbackRule: 'own_credits' }, 'session')).toEqual(lapsedWalletRefusal);
    const [row] = await db.select().from(wallets).where(eq(wallets.id, w.productWalletId));
    expect([row.status, row.monthlyAllowanceCents, row.fallbackRule, row.donationsEnabled]).toEqual(['paused', 120_000, 'refuse', false]);
  });

  it('SEAT-9 (partial) WAL-7 (partial) a lapsed seat-cap write judges against the allowance under the org row lock: a concurrent allowance cut is waited for, never bypassed (review #2817 P3-2)', async () => {
    if (!world) return;
    const w = world;
    await db.update(organizations).set({ policies: { seatAllowanceCents: 1_000 } }).where(eq(organizations.id, w.orgId));
    await setSubscription(w.orgId, 'canceled');

    // An admin's policy change is mid-flight: it holds the org row FOR UPDATE and has cut the allowance to 200.
    let cut!: () => void;
    const cutHeld = new Promise<void>((resolve) => { cut = resolve; });
    let commit!: () => void;
    const mayCommit = new Promise<void>((resolve) => { commit = resolve; });
    const policyChange = db.transaction(async (tx) => {
      await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, w.orgId)).for('update');
      await tx.update(organizations).set({ policies: { seatAllowanceCents: 200 } }).where(eq(organizations.id, w.orgId));
      cut();
      await mayCommit;
    });
    await cutHeld;

    // Another admin sets an 800¢ seat cap: below the allowance it can see committed (1000), above the one being written.
    let settled = false;
    const capWrite = setSeatCap(w.ids.priya, w.orgId, w.ids.dana, { monthlyCents: 800, dailyCents: null }).finally(() => { settled = true; });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false); // it waits for the policy change's lock
    } finally {
      commit();
      await policyChange;
    }

    expect(await capWrite).toEqual(lapsedWalletRefusal); // judged against 200: 800 raises the seat, refused
    expect(await capOf(w.poolId, w.ids.dana)).toBeNull();
  });

  it('SEAT-9 (partial) WAL-7 (partial) while lapsed a cap can be LOWERED or set where there was none; raising or clearing one is refused and writes nothing', async () => {
    if (!world) return;
    const w = world;
    await setDriveWalletCap(w.ids.priya, w.productId, w.ids.marcus, { dailyCents: 300, monthlyCents: 3_000 }, 'session');
    await setSubscription(w.orgId, 'canceled');

    expect(await setDriveWalletCap(w.ids.priya, w.productId, w.ids.marcus, { dailyCents: 100 }, 'session')).toMatchObject({ ok: true });
    expect(await capOf(w.productWalletId, w.ids.marcus)).toEqual({ daily: 100, monthly: 3_000 });
    expect(await setDriveWalletCap(w.ids.priya, w.productId, w.ids.marcus, { dailyCents: 50, monthlyCents: 4_000 }, 'session')).toEqual(lapsedWalletRefusal);
    expect(await setDriveWalletCap(w.ids.priya, w.productId, w.ids.marcus, { monthlyCents: null }, 'session')).toEqual(lapsedWalletRefusal);
    expect(await setDriveWalletCap(w.ids.priya, w.productId, w.ids.marcus, null, 'session')).toEqual(lapsedWalletRefusal);
    expect(await capOf(w.productWalletId, w.ids.marcus)).toEqual({ daily: 100, monthly: 3_000 });
    // Dana had no cap (unlimited within the wallet): any cap restricts her.
    expect(await setDriveWalletCap(w.ids.priya, w.productId, w.ids.dana, { dailyCents: 10, monthlyCents: 100 }, 'session')).toMatchObject({ ok: true });

    // A seat with no row of its own draws the org's allowance: below it restricts, above it loosens.
    const allowance = DEFAULT_ORG_POLICIES.seatAllowanceCents;
    expect(await setSeatCap(w.ids.priya, w.orgId, w.ids.dana, { monthlyCents: allowance + 1, dailyCents: null })).toEqual(lapsedWalletRefusal);
    expect(await capOf(w.poolId, w.ids.dana)).toBeNull();
    expect(await setSeatCap(w.ids.priya, w.orgId, w.ids.dana, { monthlyCents: allowance - 1, dailyCents: null })).toMatchObject({ ok: true });
    expect(await capOf(w.poolId, w.ids.dana)).toEqual({ daily: null, monthly: allowance - 1 });
    expect(await setSeatCap(w.ids.priya, w.orgId, w.ids.dana, null)).toEqual(lapsedWalletRefusal);
  });
});

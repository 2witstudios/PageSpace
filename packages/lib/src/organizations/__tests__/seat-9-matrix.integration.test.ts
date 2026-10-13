/**
 * SEAT-9 as one capability matrix, against a real Postgres (billing on).
 *
 * One Northwind Labs, paid, then lapsed. While lapsed: every org drive stays readable; every org-only
 * capability that adds access or spend is refused with 402 org_lapsed — inviting, creating (or taking in)
 * an org drive, the pool and allocations, loosening policies or caps, approving guests, publishing from
 * org drives, sandboxes and environments in org drives; every restricting action still works (D-OW-33);
 * the org is charged nothing for storage (D-OW-32); and the refusals delete nothing. Paid again, the
 * same calls go through. The four ways to be lapsed (unpaid, a failed payment, canceled, never paid)
 * all read as lapsed. Each clause also has its focused suite next door (org-lapse, lapsed-restrict,
 * lapsed-loosen, org-lapse-loosening, sandbox-storage-billing); this file holds them in one place.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveEnvs } from '@pagespace/db/schema/drive-envs';
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { orgGuestHolds } from '@pagespace/db/schema/org-guest-holds';
import { organizations, orgInvitations, orgMembers, orgSubscriptions, type OrgRole } from '@pagespace/db/schema/organizations';
import { driveShareLinks } from '@pagespace/db/schema/share-links';
import { walletConsumerCaps, wallets, walletFundingLegs } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import type { SessionClaims } from '../../auth/session-service';
import { EnforcedAuthContext } from '../../permissions/enforced-context';
import { canUserViewPage, getUserDriveAccess } from '../../permissions/permissions';
import { claimGuestApprovalDecision, requestGuestApproval } from '../../permissions/guest-holds';
import { revokeDriveShareLink } from '../../permissions/share-link-service';
import { createOrRotateInvitation, revokeInvitation } from '../invitations';
import { removeMember } from '../membership';
import { updateOrgPolicies } from '../policies';
import { DEFAULT_ORG_POLICIES } from '../policies-core';
import { ORG_LAPSED_MESSAGE, checkOrgActive, getOrgBillingNotice, getOrgStatus, isOrgActive } from '../status';
import { createOrgDrive, moveDriveToOrg, type OrgDriveServiceDeps } from '../../services/org-drive-service';
import { getDriveWallet, setDriveWalletCap, setSeatCap, topUpDriveWallet, updateDriveWallet } from '../../services/drive-wallet-service';
import { admitDriveComputeCreator, admitDriveOrgActive, gateComputeCharge } from '../../billing/compute-gate';
import { releaseHold } from '../../billing/credit-consume';
import { defaultReconcileSandboxStorageDeps } from '../../services/sandbox/sandbox-storage-billing';
import { reconcileSandboxStorage, MAX_BILLABLE_SPAN_MS, type ReconcileSandboxStorageDeps } from '../../services/sandbox/sandbox-storage-reconcile';
import { credentialActor } from '../../permissions/access-actor';

const deps: OrgDriveServiceDeps = {
  getOrgRole: async (tx, orgId, userId) => {
    const [row] = await tx.select({ role: orgMembers.role }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    return (row?.role ?? null) as OrgRole | null;
  },
  syncOrgMembership: async () => async () => {},
  getOrgDriveCreationPolicy: async () => 'members',
};
const deliver = vi.fn(async () => {});
const ctxFor = (userId: string): EnforcedAuthContext => {
  const claims: SessionClaims = {
    sessionId: 'sess', userId, userRole: 'user', tokenVersion: 1, adminRoleVersion: 0, type: 'user', scopes: ['*'],
    expiresAt: new Date(Date.now() + 3_600_000), driveId: undefined,
  };
  return EnforcedAuthContext.fromSession(claims);
};

const lapsedWallet = { ok: false, status: 402, code: 'org_lapsed', message: ORG_LAPSED_MESSAGE };
const lapsedPolicy = { ok: false, reason: 'org_lapsed', message: ORG_LAPSED_MESSAGE };

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;
const userIds: string[] = [];
let orgId = '';
let productId = '';
let personalDriveId = '';
let poolId = '';
let productWalletId = '';
let pageId = '';
let linkId = '';
let inviteId = '';
let envId = '';
const ids = { jono: '', priya: '', dana: '', marcus: '', gita: '', omar: '' };

async function setSubscription(status: string | null): Promise<void> {
  if (status === null) {
    await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId));
    return;
  }
  await factories.createOrgSubscription(orgId, { status }).catch(async () => {
    await db.update(orgSubscriptions).set({ status }).where(eq(orgSubscriptions.orgId, orgId));
  });
}

/** Everything a lapse must never delete or move. */
async function footprint() {
  const count = async (q: Promise<Array<{ n: number }>>) => (await q)[0].n;
  return {
    drives: await count(db.select({ n: sql<number>`count(*)::int` }).from(drives).where(eq(drives.orgId, orgId))),
    members: await count(db.select({ n: sql<number>`count(*)::int` }).from(orgMembers).where(eq(orgMembers.orgId, orgId))),
    driveMembers: await count(db.select({ n: sql<number>`count(*)::int` }).from(driveMembers).where(eq(driveMembers.driveId, productId))),
    pages: await count(db.select({ n: sql<number>`count(*)::int` }).from(pages).where(eq(pages.driveId, productId))),
    invites: await count(db.select({ n: sql<number>`count(*)::int` }).from(orgInvitations).where(eq(orgInvitations.orgId, orgId))),
    guestHolds: await count(db.select({ n: sql<number>`count(*)::int` }).from(orgGuestHolds).where(eq(orgGuestHolds.orgId, orgId))),
    envs: await count(db.select({ n: sql<number>`count(*)::int` }).from(driveEnvs).where(eq(driveEnvs.driveId, productId))),
    wallets: (await db.select().from(wallets).where(eq(wallets.orgId, orgId)))
      .map((r) => [r.id, r.monthlyRemainingCents, r.monthlyAllowanceCents, r.topupRemainingCents, r.spentCents, r.debtCents, r.status].join('|'))
      .sort(),
    legs: (await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, productWalletId))).length,
    policies: (await db.select({ p: organizations.policies }).from(organizations).where(eq(organizations.id, orgId)))[0].p,
    caps: (await db.select().from(walletConsumerCaps).where(inArray(walletConsumerCaps.walletId, [poolId, productWalletId]))).map((c) => `${c.consumerKey}|${c.dailyCapCents}|${c.monthlyCapCents}`).sort(),
  };
}

/** One storage tick over Product's environment, the real reconcile and row sources; money movement captured. */
async function storageTick(now: Date) {
  const charges: Parameters<ReconcileSandboxStorageDeps['chargeStorage']>[0][] = [];
  const result = await reconcileSandboxStorage({
    ...defaultReconcileSandboxStorageDeps,
    listAgentSessionSprites: async () => [],
    listPublishedAppRootfs: async () => [],
    listDriveEnvSprites: async () => (await defaultReconcileSandboxStorageDeps.listDriveEnvSprites()).filter((row) => row.driveId === productId),
    chargeStorage: async (input) => {
      charges.push(input);
      return defaultReconcileSandboxStorageDeps.chargeStorage(input);
    },
    orgComputeBillingEpoch: async () => new Date(0),
    now: () => now,
  });
  return { result, charges };
}

describe('a lapsed org, every capability at once (real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('seat-9-matrix.integration.test.ts', error);
      return;
    }
    process.env.DEPLOYMENT_MODE = 'cloud';
    const make = (name: string) => factories.createUser({ name, subscriptionTier: 'free', email: `${name.split(' ')[0].toLowerCase()}-${createId()}@northwind.test` });
    const [jono, priya, dana, marcus, gita, omar] = await Promise.all(['Jono', 'Priya Nair', 'Dana Kim', 'Marcus Oyelaran', 'Gita Outside', 'Omar Requester'].map(make));
    Object.assign(ids, { jono: jono.id, priya: priya.id, dana: dana.id, marcus: marcus.id, gita: gita.id, omar: omar.id });
    userIds.push(...Object.values(ids));
    const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id }).returning();
    orgId = org.id;
    await db.insert(orgMembers).values([
      { orgId, userId: jono.id, role: 'OWNER' },
      { orgId, userId: priya.id, role: 'ADMIN' },
      { orgId, userId: dana.id, role: 'MEMBER' },
      { orgId, userId: marcus.id, role: 'MEMBER' },
    ]);
    const product = await factories.createDrive(dana.id, { name: 'Product', slug: `product-${createId()}`, orgId, orgVisibility: 'OPEN' });
    productId = product.id;
    await factories.createDriveMember(productId, marcus.id, { source: 'org' });
    pageId = (await factories.createPage(productId, { title: 'Roadmap' })).id;
    personalDriveId = (await factories.createDrive(dana.id, { name: 'Dana scratch', slug: `scratch-${createId()}` })).id;
    // Gita: an outsider guest of Product.
    await db.insert(driveMembers).values({ driveId: productId, userId: gita.id, role: 'MEMBER', acceptedAt: new Date(), invitedBy: dana.id });
    linkId = (await db.insert(driveShareLinks).values({ driveId: productId, token: createId(), createdBy: dana.id }).returning({ id: driveShareLinks.id }))[0].id;
    inviteId = (await db
      .insert(orgInvitations)
      .values({ orgId, email: `lena-${createId()}@northwind.test`, role: 'MEMBER', invitedBy: priya.id, tokenHash: createId(), expiresAt: new Date(Date.now() + 7 * 86_400_000) })
      .returning({ id: orgInvitations.id }))[0].id;
    const [poolRow] = await db.insert(wallets).values({ ownerType: 'org', orgId, monthlyRemainingCents: 900_000 }).returning();
    poolId = poolRow.id;
    productWalletId = (await db
      .insert(wallets)
      .values({ ownerType: 'org', orgId, subjectType: 'drive', subjectId: productId, parentWalletId: poolId, monthlyAllowanceCents: 120_000, monthlyPeriodStart: new Date(Date.now() - 86_400_000) })
      .returning())[0].id;
    envId = createId();
    await db.insert(driveEnvs).values({
      id: envId, driveId: productId, name: 'build', createdBy: dana.id, sandboxId: `sprite-${envId.slice(0, 8)}`,
      storageLastBilledAt: new Date(Date.now() - MAX_BILLABLE_SPAN_MS), storageMeasuredBytes: 1_000_000_000, storageMeasuredAt: new Date(Date.now() - 60_000), updatedAt: new Date(),
    });
    await setSubscription('active');
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(driveEnvs).where(eq(driveEnvs.driveId, productId));
      await db.delete(creditHolds).where(inArray(creditHolds.userId, userIds));
      await db.delete(creditLedger).where(inArray(creditLedger.walletId, [poolId, productWalletId]));
      await db.delete(creditLedger).where(inArray(creditLedger.userId, userIds));
      await db.delete(aiUsageLogs).where(eq(aiUsageLogs.driveId, productId));
      await db.delete(walletConsumerCaps).where(inArray(walletConsumerCaps.walletId, [poolId, productWalletId]));
      await db.delete(wallets).where(eq(wallets.parentWalletId, poolId));
      await db.delete(wallets).where(eq(wallets.id, poolId));
      await db.delete(orgGuestHolds).where(eq(orgGuestHolds.orgId, orgId));
      await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId));
      const owned = (await db.select({ id: drives.id }).from(drives).where(inArray(drives.ownerId, userIds))).map((d) => d.id);
      const driveIds = [...new Set([productId, personalDriveId, ...owned])];
      await db.delete(driveShareLinks).where(inArray(driveShareLinks.driveId, driveIds));
      await db.delete(pagePermissions).where(inArray(pagePermissions.userId, userIds));
      await db.delete(pages).where(inArray(pages.driveId, driveIds));
      await db.delete(driveMembers).where(inArray(driveMembers.driveId, driveIds));
      await db.delete(drives).where(inArray(drives.id, driveIds));
      await db.delete(orgInvitations).where(eq(orgInvitations.orgId, orgId));
      await db.delete(orgMembers).where(eq(orgMembers.orgId, orgId));
      await db.delete(organizations).where(eq(organizations.id, orgId));
      await db.delete(users).where(inArray(users.id, userIds));
    }
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    await pool.end();
  });

  it('SEAT-9 (partial) unpaid, a failed payment, canceled and never paid are all lapsed; the Owner and Admins are told to reactivate, a Member that it is read-only', async () => {
    if (!dbAvailable) return;
    for (const status of ['unpaid', 'past_due', 'canceled', null]) {
      await setSubscription(status);
      expect(await getOrgStatus(orgId), String(status)).toMatchObject({ status: 'lapsed' });
      expect(await getOrgBillingNotice(orgId, 'OWNER')).toMatchObject({ kind: 'reactivate', canManageBilling: true });
      expect(await getOrgBillingNotice(orgId, 'ADMIN')).toMatchObject({ kind: 'reactivate', canManageBilling: true });
      expect(await getOrgBillingNotice(orgId, 'MEMBER')).toEqual({ kind: 'read_only', canManageBilling: false });
    }
    await setSubscription('active');
    expect(await isOrgActive(orgId)).toBe(true);
    expect(await getOrgBillingNotice(orgId, 'MEMBER')).toBeNull();
  });

  it('SEAT-9 (partial) lapsed: reads kept; every capability that adds access or spend refused; storage not charged; nothing deleted; restricting still works; paid again, everything is back', async () => {
    if (!dbAvailable) return;
    const hold = await requestGuestApproval({ orgId, driveId: productId, userId: ids.omar, origin: 'invite', request: { role: 'MEMBER' }, requestedBy: ids.dana });
    await setDriveWalletCap(credentialActor(ids.priya, null), productId, ids.marcus, { dailyCents: 300, monthlyCents: 3_000 }, 'session');
    await setSubscription('canceled');
    const before = await footprint();

    // Reads: every org drive stays readable to its members, and the wallet view still answers.
    expect(await getUserDriveAccess(credentialActor(ids.marcus, null), productId)).toBe(true);
    expect(await canUserViewPage(credentialActor(ids.marcus, null), pageId)).toBe(true);
    expect((await getDriveWallet(credentialActor(ids.priya, null), productId, 'session')).ok).toBe(true);

    // Inviting.
    expect(await createOrRotateInvitation({ credential: 'session', orgId, email: `new-${createId()}@northwind.test`, role: 'MEMBER', invitedBy: ids.priya, now: new Date(), deliver }))
      .toEqual({ ok: false, status: 402, reason: 'org_lapsed', message: ORG_LAPSED_MESSAGE });
    expect(deliver).not.toHaveBeenCalled();
    // Creating an org drive, or taking one in.
    expect(await createOrgDrive(ids.marcus, { authentication: null, name: 'Engineering', orgId }, deps)).toMatchObject({ ok: false, code: 'org_lapsed', status: 402 });
    expect(await moveDriveToOrg(ids.dana, personalDriveId, { credential: 'session', orgId }, deps)).toMatchObject({ ok: false, code: 'org_lapsed', status: 402 });
    // The pool and allocations.
    expect(await updateDriveWallet(credentialActor(ids.priya, null), productId, { allocationCents: 130_000 }, 'session')).toEqual(lapsedWallet);
    expect(await topUpDriveWallet(credentialActor(ids.priya, null), productId, { amountCents: 500, idempotencyKey: createId() }, 'session')).toEqual(lapsedWallet);
    // Loosening policies or caps.
    expect(await updateOrgPolicies({ actorAuthentication: null, orgId, actorId: ids.priya, patch: { seatAllowanceCents: DEFAULT_ORG_POLICIES.seatAllowanceCents + 1 } })).toEqual(lapsedPolicy);
    expect(await setDriveWalletCap(credentialActor(ids.priya, null), productId, ids.marcus, { dailyCents: 400 }, 'session')).toEqual(lapsedWallet);
    expect(await setSeatCap(ids.priya, orgId, ids.dana, { monthlyCents: DEFAULT_ORG_POLICIES.seatAllowanceCents + 1, dailyCents: null })).toEqual(lapsedWallet);
    // Approving a guest.
    expect(await claimGuestApprovalDecision({ orgId, holdId: hold.holdId, decision: 'approve', actorId: ids.priya })).toEqual(lapsedPolicy);
    // Publishing from an org drive: the guard publish-page runs first, and a published app re-start.
    expect(await checkOrgActive(orgId)).toMatchObject({ ok: false, code: 'org_lapsed', status: 402 });
    expect(await admitDriveOrgActive({ driveId: productId })).toEqual({ allowed: false, code: 'org_lapsed', message: ORG_LAPSED_MESSAGE });
    expect(await admitDriveOrgActive({ driveId: personalDriveId })).toEqual({ allowed: true });
    // Sandboxes and environments: no run on the pool, no new environment or app.
    expect(await gateComputeCharge({ kind: 'org', orgId, userId: ids.dana }, { estCostCents: 50 })).toEqual({ allowed: false, reason: 'org_lapsed', orgRefusal: 'org_lapsed' });
    expect(await admitDriveComputeCreator({ driveId: productId, userId: ids.dana })).toEqual({ allowed: false, code: 'org_lapsed', message: ORG_LAPSED_MESSAGE });
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, ids.dana))).toHaveLength(0);

    // Storage (D-OW-32): a tick charges nothing and the pool owes nothing; the env is kept.
    const lapsedTick = await storageTick(new Date());
    expect(lapsedTick.charges).toEqual([]);
    expect(lapsedTick.result).toMatchObject({ charged: 0, orgLapsedForgiven: 1 });
    expect(await db.select().from(creditLedger).where(eq(creditLedger.walletId, poolId))).toEqual([]);

    // Nothing was deleted, moved or stored by any of it.
    expect(await footprint()).toEqual(before);

    // Restricting still works ([D-OW-33]): tighten a policy, lower a cap, pause the wallet, decline a guest,
    // revoke a share link and an invitation, remove a member.
    expect(await updateOrgPolicies({ actorAuthentication: null, orgId, actorId: ids.priya, patch: { publicShareLinks: false } })).toMatchObject({ ok: true });
    expect(await setDriveWalletCap(credentialActor(ids.priya, null), productId, ids.marcus, { dailyCents: 100 }, 'session')).toMatchObject({ ok: true });
    expect(await updateDriveWallet(credentialActor(ids.priya, null), productId, { paused: true }, 'session')).toMatchObject({ ok: true });
    const second = await requestGuestApproval({ orgId, driveId: productId, userId: ids.gita, origin: 'invite', request: { role: 'MEMBER' }, requestedBy: ids.dana });
    expect(await claimGuestApprovalDecision({ orgId, holdId: second.holdId, decision: 'decline', actorId: ids.priya })).toMatchObject({ ok: true });
    expect(await revokeDriveShareLink(ctxFor(ids.dana), linkId)).toEqual({ ok: true, data: undefined });
    expect(await revokeInvitation({ orgId, invitationId: inviteId, actorId: ids.priya })).toBe(true);
    expect(await removeMember({ orgId, actorId: ids.priya, targetId: ids.marcus })).toMatchObject({ ok: true });

    // Paid again: the refused capabilities are back, with no other step.
    await setSubscription('active');
    expect((await createOrRotateInvitation({ credential: 'session', orgId, email: `back-${createId()}@northwind.test`, role: 'MEMBER', invitedBy: ids.priya, now: new Date(), deliver })).ok).toBe(true);
    expect((await createOrgDrive(ids.dana, { authentication: null, name: 'Engineering', orgId }, deps)).ok).toBe(true);
    expect(await claimGuestApprovalDecision({ orgId, holdId: hold.holdId, decision: 'approve', actorId: ids.priya })).toMatchObject({ ok: true });
    expect(await updateDriveWallet(credentialActor(ids.priya, null), productId, { paused: false }, 'session')).toMatchObject({ ok: true });
    const admitted = await gateComputeCharge({ kind: 'org', orgId, userId: ids.dana }, { estCostCents: 50 });
    expect(admitted).toMatchObject({ allowed: true, walletId: poolId });
    if (admitted.allowed && admitted.holdId) await releaseHold(admitted.holdId);
    expect(await admitDriveOrgActive({ driveId: productId })).toEqual({ allowed: true });
  });
});

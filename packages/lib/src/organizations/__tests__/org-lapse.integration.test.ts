/**
 * SEAT-9 against a real Postgres: a lapsed org keeps every org drive readable and blocks
 * its org-only capabilities through the one isOrgActive check — inviting, creating (and
 * moving in) org drives, the org pool and allocations, and the org's spend legs — and
 * nothing is deleted or reallocated. Leaving lapse restores every capability.
 *
 * The lapse is driven by the stored subscription row (the webhook's mirror, proven in
 * apps/web …/org-webhook.integration.test.ts); here it is written directly.
 *
 * Northwind Labs (Sequence Spec Part 2): Jono Owner, Priya Admin, Dana member and
 * Product's lead, Marcus member of Product. ORGS_ENABLED on. Deletes every row it
 * creates, children before parents, users last.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { organizations, orgInvitations, orgMembers, orgSubscriptions, type OrgRole } from '@pagespace/db/schema/organizations';
import { wallets, walletFundingLegs } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { createOrRotateInvitation, resendInvitation } from '../invitations';
import { ORG_LAPSED_MESSAGE, getOrgStatus, isOrgActive } from '../status';
import { createOrgDrive, moveDriveOutOfOrg, moveDriveToOrg, type OrgDriveServiceDeps } from '../../services/org-drive-service';
import { createDriveWallet, getDriveWallet, updateDriveWallet, topUpDriveWallet } from '../../services/drive-wallet-service';
import { resolveCallSpend } from '../../billing/spend-resolution';
import { getUserDriveAccess, canUserViewPage } from '../../permissions/permissions';

vi.mock('../orgs-enabled', () => ({ ORGS_ENABLED: true }));

const deps: OrgDriveServiceDeps = {
  getOrgRole: async (tx, orgId, userId) => {
    const [row] = await tx.select({ role: orgMembers.role }).from(orgMembers).where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)));
    return (row?.role ?? null) as OrgRole | null;
  },
  syncOrgMembership: async () => async () => {},
  getOrgDriveCreationPolicy: async () => 'members',
};

interface World {
  orgId: string;
  productId: string;
  pageId: string;
  personalDriveId: string;
  poolId: string;
  productWalletId: string;
  ids: Record<'jono' | 'priya' | 'dana' | 'marcus', string>;
  userIds: string[];
}

let dbAvailable = false;
let world: World | null = null;
const originalMode = process.env.DEPLOYMENT_MODE;

async function build(): Promise<World> {
  const make = (name: string) => factories.createUser({ name, subscriptionTier: 'free', email: `${name.split(' ')[0].toLowerCase()}-${createId()}@northwind.test` });
  const [jono, priya, dana, marcus] = await Promise.all(['Jono', 'Priya Nair', 'Dana Kim', 'Marcus Oyelaran'].map(make));
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
  const personal = await factories.createDrive(dana.id, { name: 'Dana scratch', slug: `scratch-${createId()}` });

  const [pool] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 900_000 }).returning();
  const [productWallet] = await db
    .insert(wallets)
    .values({ ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: product.id, parentWalletId: pool.id, monthlyAllowanceCents: 120_000, monthlyPeriodStart: new Date(Date.now() - 86_400_000) })
    .returning();
  // Marcus's own credits, funded: the source he may still choose while the org is lapsed.
  await db.insert(wallets).values({ userId: marcus.id, monthlyRemainingCents: 5_000, monthlyPeriodStart: new Date(), monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000) });

  const ids = { jono: jono.id, priya: priya.id, dana: dana.id, marcus: marcus.id };
  return { orgId: org.id, productId: product.id, pageId: page.id, personalDriveId: personal.id, poolId: pool.id, productWalletId: productWallet.id, ids, userIds: Object.values(ids) };
}

async function teardown(w: World): Promise<void> {
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  // Legs cascade with their wallet; children before the pool.
  await db.delete(wallets).where(eq(wallets.parentWalletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  const orgDrives = await db.select({ id: drives.id }).from(drives).where(inArray(drives.ownerId, w.userIds));
  const driveIds = orgDrives.map((d) => d.id);
  if (driveIds.length > 0) {
    await db.delete(pages).where(inArray(pages.driveId, driveIds));
    await db.delete(driveMembers).where(inArray(driveMembers.driveId, driveIds));
    await db.delete(drives).where(inArray(drives.id, driveIds));
  }
  await db.delete(orgInvitations).where(eq(orgInvitations.orgId, w.orgId));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

/** The webhook's mirror, written directly: the org's subscription as Stripe last reported it. */
async function setSubscription(orgId: string, status: string): Promise<void> {
  await db
    .insert(orgSubscriptions)
    .values({
      orgId,
      stripeSubscriptionId: `sub_owd3_${createId()}`,
      stripeBasePriceId: 'price_base_test',
      stripeBaseItemId: `si_${createId()}`,
      stripeSeatPriceId: 'price_seat_test',
      stripeSeatItemId: `si_${createId()}`,
      status,
    })
    .onConflictDoUpdate({ target: orgSubscriptions.orgId, set: { status } });
}

const deliver = vi.fn(async () => {});

/** Everything a lapse must never touch: drives, members, pages, wallets and their balances, legs, invites. */
async function footprint(w: World) {
  const count = async (q: Promise<Array<{ n: number }>>) => (await q)[0].n;
  return {
    drives: await count(db.select({ n: sql<number>`count(*)::int` }).from(drives).where(eq(drives.orgId, w.orgId))),
    members: await count(db.select({ n: sql<number>`count(*)::int` }).from(orgMembers).where(eq(orgMembers.orgId, w.orgId))),
    driveMembers: await count(db.select({ n: sql<number>`count(*)::int` }).from(driveMembers).where(eq(driveMembers.driveId, w.productId))),
    pages: await count(db.select({ n: sql<number>`count(*)::int` }).from(pages).where(eq(pages.driveId, w.productId))),
    invites: await count(db.select({ n: sql<number>`count(*)::int` }).from(orgInvitations).where(eq(orgInvitations.orgId, w.orgId))),
    wallets: (await db.select().from(wallets).where(eq(wallets.orgId, w.orgId)))
      .map((r) => [r.id, r.monthlyRemainingCents, r.monthlyAllowanceCents, r.topupRemainingCents, r.spentCents, r.debtCents, r.status, r.parentWalletId].join('|'))
      .sort(),
    legs: (await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, w.productWalletId))).map((l) => `${l.id}|${l.remainingCents}`).sort(),
  };
}

describe('SEAT-9 lapse gates (orgs on, real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('org-lapse.integration.test.ts', error);
    }
  });

  beforeEach(async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    deliver.mockClear();
    if (dbAvailable) world = await build();
  });

  afterEach(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (world) await teardown(world);
    world = null;
  });

  it('SEAT-9 (partial) a lapsed org refuses an invite with the SEAT-9 message and writes nothing; reactivated, the same invite goes through', async () => {
    if (!world) return;
    const w = world;
    await setSubscription(w.orgId, 'canceled');
    expect(await isOrgActive(w.orgId)).toBe(false);
    const email = `lena-${createId()}@northwind.test`;

    const refused = await createOrRotateInvitation({ orgId: w.orgId, email, role: 'MEMBER', invitedBy: w.ids.priya, now: new Date(), deliver });
    expect(refused).toEqual({ ok: false, status: 402, reason: 'org_lapsed', message: ORG_LAPSED_MESSAGE });
    expect(deliver).not.toHaveBeenCalled();
    expect(await db.select().from(orgInvitations).where(eq(orgInvitations.orgId, w.orgId))).toHaveLength(0);

    await setSubscription(w.orgId, 'active');
    const accepted = await createOrRotateInvitation({ orgId: w.orgId, email, role: 'MEMBER', invitedBy: w.ids.priya, now: new Date(), deliver });
    expect(accepted.ok).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('SEAT-9 (partial) a pending invite survives the lapse untouched: resend is refused and its link is not rotated', async () => {
    if (!world) return;
    const w = world;
    const issued = await createOrRotateInvitation({ orgId: w.orgId, email: `tomas-${createId()}@northwind.test`, role: 'MEMBER', invitedBy: w.ids.jono, now: new Date(), deliver });
    if (!issued.ok) throw new Error('fixture invite failed');
    const [before] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, issued.invitation.id));

    await setSubscription(w.orgId, 'unpaid');
    const resent = await resendInvitation({ orgId: w.orgId, invitationId: issued.invitation.id, now: new Date(), deliver });
    expect(resent).toEqual({ ok: false, status: 402, reason: 'org_lapsed', message: ORG_LAPSED_MESSAGE });
    const [after] = await db.select().from(orgInvitations).where(eq(orgInvitations.id, issued.invitation.id));
    expect(after.tokenHash).toBe(before.tokenHash);
    expect(after.expiresAt).toEqual(before.expiresAt);
  });

  it('SEAT-9 (partial) a lapsed org keeps every org drive readable to its members and deletes nothing', async () => {
    if (!world) return;
    const w = world;
    const before = await footprint(w);
    await setSubscription(w.orgId, 'canceled');

    expect(await getUserDriveAccess(w.ids.marcus, w.productId)).toBe(true);
    expect(await canUserViewPage(w.ids.marcus, w.pageId)).toBe(true);
    expect(await getUserDriveAccess(w.ids.dana, w.productId)).toBe(true);
    const read = await getDriveWallet(w.ids.priya, w.productId, 'session');
    expect(read.ok).toBe(true);

    expect(await footprint(w)).toEqual(before);
  });

  it('SEAT-9 (partial) a lapsed org cannot create an org drive or take a drive in; a drive can still move OUT', async () => {
    if (!world) return;
    const w = world;
    await setSubscription(w.orgId, 'canceled');

    const created = await createOrgDrive(w.ids.marcus, { name: 'Engineering', orgId: w.orgId }, deps);
    expect(created).toEqual({ ok: false, code: 'org_lapsed', status: 402, message: ORG_LAPSED_MESSAGE });
    const movedIn = await moveDriveToOrg(w.ids.dana, w.personalDriveId, { orgId: w.orgId }, deps);
    expect(movedIn).toMatchObject({ ok: false, code: 'org_lapsed', status: 402 });
    const [personal] = await db.select({ orgId: drives.orgId }).from(drives).where(eq(drives.id, w.personalDriveId));
    expect(personal.orgId).toBeNull();

    const movedOut = await moveDriveOutOfOrg(w.ids.priya, w.productId, { implicitMembers: 'keep' }, deps);
    expect(movedOut.ok).toBe(true);

    // Reactivated: creation works again.
    await setSubscription(w.orgId, 'active');
    const again = await createOrgDrive(w.ids.marcus, { name: 'Engineering', orgId: w.orgId }, deps);
    expect(again.ok).toBe(true);
  });

  it('SEAT-9 (partial) the org pool and allocations are frozen while lapsed: every drive-wallet write is refused, nothing moves', async () => {
    if (!world) return;
    const w = world;
    const before = await footprint(w);
    await setSubscription(w.orgId, 'past_due');
    // past_due is Stripe still retrying: the org keeps working.
    expect((await updateDriveWallet(w.ids.priya, w.productId, { allocationCents: 130_000 }, 'session')).ok).toBe(true);
    await db.update(wallets).set({ monthlyAllowanceCents: 120_000 }).where(eq(wallets.id, w.productWalletId));

    await setSubscription(w.orgId, 'unpaid');
    const lapsedRefusal = { ok: false, status: 402, code: 'org_lapsed', message: ORG_LAPSED_MESSAGE };
    expect(await updateDriveWallet(w.ids.priya, w.productId, { allocationCents: 1 }, 'session')).toEqual(lapsedRefusal);
    expect(await updateDriveWallet(w.ids.priya, w.productId, { paused: true }, 'session')).toEqual(lapsedRefusal);
    expect(await topUpDriveWallet(w.ids.priya, w.productId, { amountCents: 500, idempotencyKey: createId() }, 'session')).toEqual(lapsedRefusal);
    await db.delete(wallets).where(eq(wallets.id, w.productWalletId));
    expect(await createDriveWallet(w.ids.priya, w.productId, { allocationCents: 50_000 }, 'session')).toEqual(lapsedRefusal);
    expect(await db.select().from(wallets).where(and(eq(wallets.subjectType, 'drive'), eq(wallets.subjectId, w.productId)))).toHaveLength(0);
    // Put the fixture back as it was (the delete above was the test's own, not the lapse's).
    await db.insert(wallets).values({ id: w.productWalletId, ownerType: 'org', orgId: w.orgId, subjectType: 'drive', subjectId: w.productId, parentWalletId: w.poolId, monthlyAllowanceCents: 120_000, monthlyPeriodStart: new Date(Date.now() - 86_400_000) });
    expect((await footprint(w)).wallets.length).toBe(before.wallets.length);
  });

  it('SEAT-9 (partial) SPEND-4 (partial) while lapsed a member choosing the drive wallet or seat is refused (charges nothing, offers own credits); choosing own credits still works', async () => {
    if (!world) return;
    const w = world;
    const target = (chosen: 'drive_wallet' | 'seat_allowance' | 'own_credits') => ({ kind: 'drive' as const, driveId: w.productId, chosen });
    const active = await resolveCallSpend({ userId: w.ids.marcus, consumerTier: 'free', target: target('drive_wallet'), reservationCents: 10, recordRefusal: false });
    expect(active).toMatchObject({ kind: 'spend', source: 'drive_wallet', walletId: w.productWalletId });

    await setSubscription(w.orgId, 'canceled');
    for (const chosen of ['drive_wallet', 'seat_allowance'] as const) {
      const refused = await resolveCallSpend({ userId: w.ids.marcus, consumerTier: 'free', target: target(chosen), reservationCents: 10, recordRefusal: false });
      expect(refused).toMatchObject({ kind: 'refuse', source: chosen, reason: 'source_paused', chargeCents: 0 });
      if (refused.kind !== 'refuse') throw new Error('expected a refusal');
      expect(refused.options.map((o) => o.source)).toContain('own_credits');
    }
    const own = await resolveCallSpend({ userId: w.ids.marcus, consumerTier: 'free', target: target('own_credits'), reservationCents: 10, recordRefusal: false });
    expect(own).toMatchObject({ kind: 'spend', source: 'own_credits', fallbackApplied: false });

    await setSubscription(w.orgId, 'active');
    expect(await resolveCallSpend({ userId: w.ids.marcus, consumerTier: 'free', target: target('drive_wallet'), reservationCents: 10, recordRefusal: false })).toMatchObject({
      kind: 'spend',
      source: 'drive_wallet',
    });
  });

  it("SEAT-9 (partial) SPEND-6 (partial) while lapsed an automation SKIPS — it never falls back to the person it runs for", async () => {
    if (!world) return;
    const w = world;
    const automation = { kind: 'automation' as const, driveId: w.productId };
    expect(await resolveCallSpend({ userId: w.ids.dana, consumerTier: 'free', target: automation, reservationCents: 10, recordRefusal: false })).toMatchObject({
      kind: 'spend',
      source: 'drive_wallet',
      walletId: w.productWalletId,
    });

    await setSubscription(w.orgId, 'unpaid');
    const skipped = await resolveCallSpend({ userId: w.ids.dana, consumerTier: 'free', target: automation, reservationCents: 10, recordRefusal: false });
    expect(skipped).toMatchObject({ kind: 'skip', reason: 'drive_wallet_paused', walletId: w.productWalletId, chargeCents: 0 });
    // The drive wallet's stored status is untouched: the pause is a read of the lapse, not a write.
    const [stored] = await db.select({ status: wallets.status }).from(wallets).where(eq(wallets.id, w.productWalletId));
    expect(stored.status).toBe('active');
  });

  it('SEAT-9 (partial) where billing is off (onprem, tenant) an org never lapses, whatever row is stored', async () => {
    if (!world) return;
    const w = world;
    await setSubscription(w.orgId, 'canceled');
    for (const mode of ['onprem', 'tenant']) {
      process.env.DEPLOYMENT_MODE = mode;
      expect(await getOrgStatus(w.orgId)).toEqual({ status: 'active', reason: null });
      const invite = await createOrRotateInvitation({ orgId: w.orgId, email: `aisha-${mode}-${createId()}@northwind.test`, role: 'MEMBER', invitedBy: w.ids.jono, now: new Date(), deliver });
      expect(invite.ok).toBe(true);
    }
  });
});

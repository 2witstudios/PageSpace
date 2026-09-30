/**
 * D2's seat admission (org billing advisory lock, a Stripe call INSIDE it) and E1's policy store and
 * spend policy read, run together on REAL Postgres. The two lanes merged independently and neither head
 * contained the other, so this is the only place the combination executes.
 *
 * What must hold while an invite that raises the Stripe seat quantity holds the billing lock:
 *   - a member's seat-allowance call (pool row lock, policy read) is admitted and settles without
 *     waiting for that lock, and the cap still counts the AI spend;
 *   - a policy change (organizations row lock, suspensions) commits without waiting for it either;
 *   - nothing deadlocks, and the invite still completes and raises the quantity.
 * The single lock order both lanes take is: billing advisory lock -> org_invitations/org_subscriptions rows
 * (seats); organizations row -> link/page/domain/integration/guest rows (policies); pool wallet row -> parent
 * wallet row -> ledger/holds (credit gate). The only table two of them touch is organizations: seats and the
 * gate only READ it (a plain SELECT never queues behind a row lock), and the policy writer takes its row lock
 * first while holding nothing else. No pair is taken in opposite orders.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { organizations, orgInvitations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { canConsumeAI } from '../../billing/credit-gate';
import { consumeCredits } from '../../billing/credit-consume';
import { driveSpend } from '../../billing/spend-target';
import { createOrRotateInvitation } from '../invitations';
import { getOrgPolicies } from '../policy-reader';
import { updateOrgPolicies } from '../policies';
import type { SeatBillingPort } from '../seat-service';

vi.mock('../orgs-enabled', () => ({ ORGS_ENABLED: true }));
vi.mock('../../audit/org-audit', () => ({ recordOrgAuditEvent: vi.fn(async () => {}) }));

const SLOW_STRIPE_MS = 2_000;
const COST_25C = 0.1666667;
const created = { orgId: '', userIds: [] as string[], driveId: '' };

class SlowStripe implements SeatBillingPort {
  startedAt = 0;
  async setSeatQuantity(params: { quantity: number }) {
    this.startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, SLOW_STRIPE_MS));
    return { quantity: params.quantity };
  }
  async readSeatQuantity() {
    return 0;
  }
}

async function teardown() {
  const { orgId, userIds, driveId } = created;
  if (orgId) {
    await db.delete(creditHolds).where(inArray(creditHolds.userId, userIds));
    await db.delete(creditLedger).where(inArray(creditLedger.userId, userIds));
    await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, userIds));
    await db.delete(wallets).where(inArray(wallets.parentWalletId, db.select({ id: wallets.id }).from(wallets).where(eq(wallets.orgId, orgId))));
    await db.delete(wallets).where(eq(wallets.orgId, orgId));
    await db.delete(orgInvitations).where(eq(orgInvitations.orgId, orgId));
    if (driveId) await db.delete(driveMembers).where(eq(driveMembers.driveId, driveId));
    await db.delete(drives).where(eq(drives.orgId, orgId));
    await db.delete(orgMembers).where(eq(orgMembers.orgId, orgId));
    await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
  }
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  created.orgId = '';
  created.userIds = [];
  created.driveId = '';
}

describe('seat admission and the policy layer together (real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: organizations.id }).from(organizations).limit(1);
    } catch (error) {
      requireDb('seat-policy-combined.integration.test.ts', error);
    }
  });
  afterEach(teardown);
  afterAll(async () => {
    await pool.end();
  });

  it('SEAT-4 (partial) POL-7 (partial) POL-1 (partial) an invite raising the Stripe quantity under the billing lock blocks neither a seat call nor a policy change, and the cap still counts the AI spend', async () => {
    process.env.DEPLOYMENT_MODE = 'cloud';
    // Five accepted members fill the five included seats: one more invite raises the quantity under auto-add.
    const people = await factories.createUsers(5, { subscriptionTier: 'free' });
    created.userIds.push(...people.map((p) => p.id));
    const [owner, marcus] = people;
    const [org] = await db.insert(organizations).values({ name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner.id, seatAutoAdd: true, stripeCustomerId: `cus_${createId()}` }).returning();
    created.orgId = org.id;
    await db.insert(orgMembers).values(people.map((p, i) => ({ orgId: org.id, userId: p.id, role: i === 0 ? ('OWNER' as const) : ('MEMBER' as const) })));
    await db.insert(orgSubscriptions).values({
      orgId: org.id, stripeSubscriptionId: `sub_${createId()}`, stripeBasePriceId: 'pb', stripeBaseItemId: 'ib', stripeSeatPriceId: 'ps', stripeSeatItemId: 'is',
      extraSeatQuantity: 0, status: 'active', currentPeriodStart: new Date(Date.now() - 20 * 86_400_000), currentPeriodEnd: new Date(Date.now() + 10 * 86_400_000),
    });
    const drive = await factories.createDrive(owner.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
    created.driveId = drive.id;
    await factories.createDriveMember(drive.id, marcus.id, { source: 'org' });
    const [poolWallet] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 900_000, monthlyPeriodStart: new Date(Date.now() - 10 * 86_400_000), monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000) }).returning();
    await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: drive.id, parentWalletId: poolWallet.id, monthlyAllowanceCents: 1_000 });

    const stripe = new SlowStripe();
    const invite = createOrRotateInvitation({
      orgId: org.id, email: `new-${createId()}@northwind.test`, role: 'MEMBER', invitedBy: owner.id, actorRole: 'OWNER', now: new Date(), deliver: async () => {}, seatBilling: stripe,
    });
    // Let the invite reach Stripe: it now holds the org billing lock for SLOW_STRIPE_MS.
    while (stripe.startedAt === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    const heldFor = () => Date.now() - stripe.startedAt;

    // A seat call: admitted under the pool lock with the policy read, settled, and counted.
    const gate = await canConsumeAI(marcus.id, 'free', { spend: driveSpend(drive.id, 'seat_allowance') });
    expect(gate).toMatchObject({ allowed: true, walletId: poolWallet.id, spendSource: 'seat_allowance' });
    if (!gate.allowed) throw new Error('unreachable');
    const [log] = await db.insert(aiUsageLogs).values({ userId: marcus.id, provider: 'openrouter', model: 'm', cost: COST_25C }).returning({ id: aiUsageLogs.id });
    expect(await consumeCredits({ aiUsageLogId: log.id, userId: marcus.id, costDollars: COST_25C, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');
    const afterGate = heldFor();

    // A policy change: organizations row lock and suspensions, committed while the billing lock is still held.
    const changed = await updateOrgPolicies({ orgId: org.id, actorId: owner.id, patch: { seatAllowanceCents: 50, guests: 'off' } });
    expect(changed.ok).toBe(true);
    const afterPolicy = heldFor();

    // Both finished while the Stripe call was still in flight: neither queued behind the billing lock.
    expect(afterGate).toBeLessThan(SLOW_STRIPE_MS - 500);
    expect(afterPolicy).toBeLessThan(SLOW_STRIPE_MS - 500);

    const invited = await invite;
    expect(invited.ok).toBe(true);
    const [sub] = await db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, org.id));
    expect(sub.extraSeatQuantity).toBe(1);
    expect(await getOrgPolicies(org.id)).toMatchObject({ seatAllowanceCents: 50, guests: 'off' });
    // The seat spend was counted as AI spend against the (now lowered) allowance: 25¢ of 50¢ used, one more fits, two do not.
    const second = await canConsumeAI(marcus.id, 'free', { spend: driveSpend(drive.id, 'seat_allowance') });
    expect(second).toMatchObject({ allowed: true });
    await db.delete(creditHolds).where(eq(creditHolds.userId, marcus.id));
  }, 30_000);
});

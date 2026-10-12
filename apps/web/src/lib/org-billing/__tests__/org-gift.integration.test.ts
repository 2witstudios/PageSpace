// @vitest-environment node
/**
 * SEAT-8 end to end on a REAL Postgres: an org exists only paid or gifted.
 *
 *   - creating the org starts ONE Business subscription on the org's own customer, waiting
 *     for a card (`incomplete`, no trial), with nothing funded — the org is lapsed;
 *   - the first real paid invoice, delivered through the signed webhook, funds the pool at
 *     what was paid × the included-credit ratio;
 *   - an admin gift, through the same lib shell the admin route calls
 *     (apps/admin .../orgs/[orgId]/gift-subscription), is written ON the org's stored
 *     subscription for a pinned number of extra seats (D-OW-54); it voids the lapsed org's
 *     open renewal invoice first, and the $0 invoice Stripe then issues — carrying the
 *     metadata the gift wrote — lifts the lapse through the webhook and funds the pool at
 *     list price × ratio for the pinned seats;
 *   - a gift invoice on any other subscription funds nothing.
 *
 * A second test covers the rest of D-OW-54: an interrupted gift completes on retry with its
 * one coupon; past the gifted seats an invite is refused even with auto-add on; a gift invoice
 * billing seats the Owner inflated funds only the pinned seats; and a revoke takes the gift
 * off, after which a re-gift reuses the coupon.
 *
 * Stripe is the in-memory FakeOrgStripe (provisioning + the webhook's mirror read) plus a
 * gift port that writes into that same fake, so the gift invoice's metadata is derived from
 * what the gift actually wrote — never typed into the test by hand.
 * Requires DATABASE_URL → a migrated Postgres (requireDb). Deletes every row it creates.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Stripe from 'stripe';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNull } from '@pagespace/db/operators';
import { organizations, orgMembers, orgSubscriptions, orgSubscriptionFunding } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { creditLedger } from '@pagespace/db/schema/credits';
import { stripeEvents } from '@pagespace/db/schema/subscriptions';
import { users } from '@pagespace/db/schema/auth';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { createOrganization } from '@pagespace/lib/organizations/repository';
import { getOrgStatus } from '@pagespace/lib/organizations/status';
import { ORG_ID_METADATA_KEY, ORG_SUBSCRIPTION_KIND, type OrgBusinessPrices } from '@pagespace/lib/billing/org-subscription-core';
import { orgPoolListPriceGrantCents } from '@pagespace/lib/billing/wallet-funding';
import { allowanceCentsForPaidCents, centsFromDollars, tierListPriceCents } from '@pagespace/lib/billing/money-model';
import { TIER_PLAN_LIMITS } from '@pagespace/lib/billing/subscription-tiers';
import { giftOrgSubscription, ungiftOrgSubscription, type OrgGiftStripe } from '@pagespace/lib/billing/org-gift';
import { orgInvitations } from '@pagespace/db/schema/organizations';
import { admitSeat } from '@pagespace/lib/organizations/seat-service';
import { stripeConfig } from '@/lib/stripe-config';
import { ensureOrgBusinessSubscription, type OrgBillingDeps, type OrgBillingStripe } from '@/lib/org-billing/org-subscription';
import { FakeOrgStripe } from './fake-org-stripe';

const fakeHolder = vi.hoisted(() => ({ current: null as OrgBillingStripe | null }));
vi.mock('@/lib/org-billing/org-subscription', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/org-billing/org-subscription')>();
  return {
    ...actual,
    stripeOrgBilling: () => {
      if (!fakeHolder.current) throw new Error('no fake Stripe installed for this test');
      return fakeHolder.current;
    },
  };
});

import { POST } from '@/app/api/stripe/webhook/route';

const WEBHOOK_SECRET = 'whsec_seat8_local_test_secret';
const PRICES: OrgBusinessPrices = { basePriceId: stripeConfig.orgPriceIds.businessBase, seatPriceId: stripeConfig.orgPriceIds.extraSeat };
const BASE_CENTS = tierListPriceCents('business');
const SEAT_CENTS = centsFromDollars(TIER_PLAN_LIMITS.business.extraSeatUsd);
const DAY = 86_400;
const ADMIN_ID = 'admin_seat8_operator';

const signer = new Stripe('sk_test_signer_only_no_network');
const env = { mode: process.env.DEPLOYMENT_MODE, secret: process.env.STRIPE_WEBHOOK_SECRET, key: process.env.STRIPE_SECRET_KEY };
const orgIds: string[] = [];
const userIds: string[] = [];
const eventIds: string[] = [];
let dbAvailable = false;

/** A $0 invoice Stripe issued for the gift, with the metadata and seat count it was issued with. */
interface IssuedGiftInvoice {
  id: string;
  subscriptionId: string;
  metadata: Record<string, string>;
  extraSeats: number;
}

/**
 * The admin gift's Stripe calls, applied to the same in-memory Stripe the org lives in. Faithful
 * to what the gift relies on: metadata keys merge (an empty string removes one), a discount of
 * '' removes the coupon, a billing-cycle reset issues a $0 invoice at once (paid, since the
 * coupon zeroes it), and a subscription is `active` only once none of its invoices is open —
 * a failed renewal left open keeps it lapsed whatever else is paid.
 */
class FakeGiftStripe implements OrgGiftStripe {
  coupons: Array<{ id: string; percentOff: number }> = [];
  couponCreates = 0;
  discounts = new Map<string, string[]>();
  updates: Array<{ subscriptionId: string; anchorNow: boolean; proration: string }> = [];
  issued: IssuedGiftInvoice[] = [];
  voided: string[] = [];
  failNextUpdate: Error | null = null;
  constructor(private readonly org: FakeOrgStripe) {}
  async retrieveCoupon(id: string) {
    return this.coupons.find((c) => c.id === id) ?? null;
  }
  async createCoupon(params: Parameters<OrgGiftStripe['createCoupon']>[0]) {
    if (this.coupons.some((c) => c.id === params.id)) throw new Error('resource_already_exists: Coupon already exists.');
    this.couponCreates += 1;
    this.coupons.push({ id: params.id, percentOff: params.percent_off });
    return { id: params.id };
  }
  async listOpenInvoiceIds(subscriptionId: string) {
    return (this.org.invoices.get(subscriptionId) ?? []).filter((i) => i.status === 'open').map((i) => i.id);
  }
  async voidInvoice(invoiceId: string) {
    const invoice = [...this.org.invoices.values()].flat().find((i) => i.id === invoiceId);
    if (!invoice || invoice.status !== 'open') throw new Error(`Invoice '${invoiceId}' is not open`);
    invoice.status = 'void';
    this.voided.push(invoiceId);
  }
  async updateSubscription(subscriptionId: string, params: Parameters<OrgGiftStripe['updateSubscription']>[1]) {
    if (this.failNextUpdate) {
      const error = this.failNextUpdate;
      this.failNextUpdate = null;
      throw error;
    }
    const sub = this.org.subscriptions.get(subscriptionId);
    if (!sub) throw new Error(`No such subscription: '${subscriptionId}'`);
    const metadata: Record<string, string> = { ...sub.metadata };
    for (const [k, v] of Object.entries(params.metadata)) {
      if (v === '') delete metadata[k];
      else metadata[k] = v;
    }
    sub.metadata = metadata;
    this.discounts.set(subscriptionId, params.discounts === '' ? [] : params.discounts.map((d) => d.coupon));
    if ('items' in params) {
      for (const item of params.items) {
        const target = sub.items.find((i) => i.id === item.id);
        if (!target) throw new Error(`No such subscription item: '${item.id}'`);
        target.quantity = item.quantity;
      }
    }
    const anchorNow = 'billing_cycle_anchor' in params && params.billing_cycle_anchor === 'now';
    this.updates.push({ subscriptionId, anchorNow, proration: params.proration_behavior });
    if (anchorNow) {
      const invoice = this.org.addInvoice(sub, 0);
      invoice.status = 'paid';
      const seatItem = sub.items.find((i) => i.priceId === PRICES.seatPriceId);
      this.issued.push({ id: invoice.id, subscriptionId, metadata: { ...metadata }, extraSeats: seatItem?.quantity ?? 0 });
      const open = (this.org.invoices.get(subscriptionId) ?? []).some((i) => i.status === 'open');
      if (!open) sub.status = 'active';
    }
    return { id: sub.id, status: sub.status };
  }
}

interface Org {
  orgId: string;
  customerId: string;
  subscriptionId: string;
  stripe: FakeOrgStripe;
}

async function northwind(seats: number): Promise<Org> {
  const owner = await factories.createUser({ email: `jono+seat8${Date.now()}${Math.random().toString(36).slice(2, 8)}@northwind.test`, name: 'Jono' });
  userIds.push(owner.id);
  const created = await createOrganization({ name: 'Northwind Labs', slug: `northwind-${Math.random().toString(36).slice(2, 10)}`, ownerId: owner.id });
  if (!created.ok) throw new Error(`org create failed: ${created.reason}`);
  orgIds.push(created.organization.id);
  const stripe = new FakeOrgStripe();
  const deps: OrgBillingDeps = { stripe, prices: () => PRICES, countSeats: async () => seats };
  const { linkage } = await ensureOrgBusinessSubscription(created.organization.id, deps);
  fakeHolder.current = stripe;
  return { orgId: created.organization.id, customerId: linkage.stripeCustomerId, subscriptionId: linkage.stripeSubscriptionId, stripe };
}

/** A Business invoice: the base and `extraSeats` seat lines, at list (`paid`) or zeroed by a 100% coupon. */
function invoiceObject(spec: { customer: string; subscriptionId: string; metadata: Record<string, string>; extraSeats: number; paid: boolean; billingReason: string; periodStart: number; id?: string }) {
  const periodEnd = spec.periodStart + 30 * DAY;
  const lines = [
    { amount: spec.paid ? BASE_CENTS : 0, parent: { subscription_item_details: { subscription_item: 'si_base' } }, discount_amounts: [], quantity: 1, pricing: { price_details: { price: PRICES.basePriceId } }, period: { start: spec.periodStart, end: periodEnd } },
    { amount: spec.paid ? SEAT_CENTS * spec.extraSeats : 0, parent: { subscription_item_details: { subscription_item: 'si_seat' } }, discount_amounts: [], quantity: spec.extraSeats, pricing: { price_details: { price: PRICES.seatPriceId } }, period: { start: spec.periodStart, end: periodEnd } },
  ];
  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  return {
    id: spec.id ?? `in_seat8_${Math.random().toString(36).slice(2, 12)}`,
    object: 'invoice',
    currency: 'usd',
    customer: spec.customer,
    amount_paid: total,
    subtotal: total,
    billing_reason: spec.billingReason,
    period_start: spec.periodStart,
    period_end: periodEnd,
    livemode: false,
    parent: { type: 'subscription_details', subscription_details: { metadata: spec.metadata, subscription: spec.subscriptionId } },
    lines: { object: 'list', data: lines },
  };
}

async function deliver(type: string, object: unknown): Promise<number> {
  const id = `evt_seat8_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  eventIds.push(id);
  const payload = JSON.stringify({ id, object: 'event', type, created: Math.floor(Date.now() / 1000), livemode: false, api_version: '2026-02-25.clover', data: { object } });
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const request = new Request('https://example.com/api/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': header } });
  return (await POST(request as unknown as import('next/server').NextRequest)).status;
}

async function poolOf(orgId: string) {
  const [pool] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.orgId, orgId), eq(wallets.ownerType, 'org'), isNull(wallets.subjectType), isNull(wallets.parentWalletId)));
  return pool ?? null;
}

const poolCents = async (orgId: string) => (await poolOf(orgId))?.monthlyRemainingCents ?? 0;

describe('SEAT-8 an org exists only paid or gifted (real Postgres, in-memory Stripe)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('org-gift.integration.test.ts', error);
    }
    process.env.DEPLOYMENT_MODE = 'cloud';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    if (!process.env.STRIPE_SECRET_KEY) process.env.STRIPE_SECRET_KEY = 'sk_test_signature_only';
  });

  afterAll(async () => {
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('DEPLOYMENT_MODE', env.mode);
    restore('STRIPE_WEBHOOK_SECRET', env.secret);
    restore('STRIPE_SECRET_KEY', env.key);
    if (!dbAvailable) return;
    if (eventIds.length) await db.delete(stripeEvents).where(inArray(stripeEvents.id, eventIds));
    if (orgIds.length) {
      const owned = (await db.select({ id: wallets.id }).from(wallets).where(inArray(wallets.orgId, orgIds))).map((w) => w.id);
      if (owned.length) {
        await db.delete(creditLedger).where(inArray(creditLedger.walletId, owned));
        await db.delete(wallets).where(inArray(wallets.id, owned));
      }
      await db.delete(orgSubscriptionFunding).where(inArray(orgSubscriptionFunding.orgId, orgIds));
      await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (userIds.length) {
      await db.delete(creditLedger).where(inArray(creditLedger.userId, userIds));
      await db.delete(users).where(inArray(users.id, userIds));
    }
  });

  it('SEAT-8 creation starts one Business subscription awaiting a card with no trial and nothing funded (org lapsed); the first real paid invoice funds the pool at paid × ratio; an admin gift on the org\'s OWN subscription voids the lapsed renewal, lifts the lapse through its own $0 invoice and funds list × ratio for the pinned seats; a gift on any other subscription funds nothing', async () => {
    if (!dbAvailable) return;
    const extraSeats = 2;
    const org = await northwind(TIER_PLAN_LIMITS.business.includedSeats + extraSeats);
    const meta = { kind: ORG_SUBSCRIPTION_KIND, [ORG_ID_METADATA_KEY]: org.orgId };

    // 1. Creation: exactly one subscription, on the org's own customer, awaiting a card. No trial, nothing funded.
    const subs = [...org.stripe.subscriptions.values()];
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ id: org.subscriptionId, customerId: org.customerId, status: 'incomplete', trialEnd: null });
    expect(org.stripe.invoiceFor(org.subscriptionId)).toMatchObject({ status: 'open', amountPaidCents: 0 });
    const [orgRow] = await db.select({ stripeCustomerId: organizations.stripeCustomerId }).from(organizations).where(eq(organizations.id, org.orgId));
    expect(orgRow.stripeCustomerId).toBe(org.customerId);
    expect(await getOrgStatus(org.orgId)).toEqual({ status: 'lapsed', reason: 'incomplete' });
    expect(await poolCents(org.orgId)).toBe(0);

    // An admin cannot gift a subscription Stripe will expire: refused, no Stripe write.
    const gift = new FakeGiftStripe(org.stripe);
    expect(await giftOrgSubscription({ orgId: org.orgId, adminUserId: ADMIN_ID, reason: 'Design partner', extraSeats }, gift)).toEqual({ kind: 'refused', reason: 'awaiting_first_payment' });
    expect(gift.coupons).toHaveLength(0);

    // 2. The first REAL payment funds the pool at what was paid × ratio.
    org.stripe.payLatestInvoice(org.subscriptionId);
    const firstPaid = invoiceObject({ customer: org.customerId, subscriptionId: org.subscriptionId, metadata: meta, extraSeats, paid: true, billingReason: 'subscription_create', periodStart: 1_800_000_000 });
    expect(await deliver('invoice.paid', firstPaid)).toBe(200);
    const paidGrant = allowanceCentsForPaidCents(firstPaid.amount_paid, 'business');
    expect(firstPaid.amount_paid).toBe(BASE_CENTS + SEAT_CENTS * extraSeats);
    expect(paidGrant).toBeGreaterThan(0);
    expect(paidGrant).toBeLessThan(firstPaid.amount_paid); // the ratio, not the price (A-11)
    expect(await poolCents(org.orgId)).toBe(paidGrant);
    expect((await getOrgStatus(org.orgId)).status).toBe('active');

    // The renewal fails: the org lapses (past_due), with that renewal invoice still open.
    const renewal = org.stripe.openRenewalInvoice(org.subscriptionId, 'past_due');
    expect(await deliver('customer.subscription.updated', { id: org.subscriptionId, object: 'subscription', customer: org.customerId, status: 'past_due', metadata: meta })).toBe(200);
    expect((await getOrgStatus(org.orgId)).status).toBe('lapsed');

    // 3. The admin gift, pinned at the org's 2 extra seats: it voids the open renewal first
    // (no more retries charging the gifted period), then is written ON the stored subscription,
    // re-anchored so Stripe issues the $0 gift invoice now.
    const gifted = await giftOrgSubscription({ orgId: org.orgId, adminUserId: ADMIN_ID, reason: 'Design partner', extraSeats }, gift);
    expect(gifted).toMatchObject({ kind: 'gifted', subscriptionId: org.subscriptionId, restoresNow: true, giftedExtraSeats: extraSeats, voidedInvoiceIds: [renewal.id] });
    expect(renewal.status).toBe('void');
    expect(gift.updates).toEqual([{ subscriptionId: org.subscriptionId, anchorNow: true, proration: 'none' }]);
    expect(gift.coupons).toEqual([{ id: gift.discounts.get(org.subscriptionId)?.[0], percentOff: 100 }]);
    const [pinned] = await db.select({ giftedExtraSeats: orgSubscriptions.giftedExtraSeats }).from(orgSubscriptions).where(eq(orgSubscriptions.orgId, org.orgId));
    expect(pinned.giftedExtraSeats).toBe(extraSeats);
    // Nothing is hand-set: the org is still lapsed until Stripe's own events for the gift arrive.
    expect((await getOrgStatus(org.orgId)).status).toBe('lapsed');

    // Stripe's events for the gift: the subscription (as Stripe now holds it) and the $0 invoice
    // it issued, carrying the metadata the gift wrote.
    expect(gift.issued).toHaveLength(1);
    const issued = gift.issued[0];
    const giftedSub = org.stripe.subscriptions.get(org.subscriptionId)!;
    expect(giftedSub.status).toBe('active'); // only because the failed renewal was voided
    expect(await deliver('customer.subscription.updated', { id: org.subscriptionId, object: 'subscription', customer: org.customerId, status: giftedSub.status, metadata: giftedSub.metadata })).toBe(200);
    const giftInvoice = invoiceObject({ id: issued.id, customer: org.customerId, subscriptionId: org.subscriptionId, metadata: issued.metadata, extraSeats: issued.extraSeats, paid: false, billingReason: 'subscription_update', periodStart: 1_800_000_000 + 40 * DAY });
    expect(giftInvoice.amount_paid).toBe(0);
    expect(await deliver('invoice.paid', giftInvoice)).toBe(200);
    const listGrant = orgPoolListPriceGrantCents(extraSeats);
    expect(listGrant).toBe(allowanceCentsForPaidCents(BASE_CENTS + SEAT_CENTS * extraSeats, 'business'));
    expect(await poolCents(org.orgId)).toBe(paidGrant + listGrant);
    expect((await getOrgStatus(org.orgId)).status).toBe('active');
    const [stored] = await db.select({ gifted: orgSubscriptions.gifted }).from(orgSubscriptions).where(eq(orgSubscriptions.orgId, org.orgId));
    expect(stored.gifted).toBe(true);
    // Once gifted, a second gift is refused (fail closed, no second coupon).
    expect(await giftOrgSubscription({ orgId: org.orgId, adminUserId: ADMIN_ID, reason: 'again', extraSeats }, gift)).toEqual({ kind: 'refused', reason: 'already_gifted' });
    expect(gift.couponCreates).toBe(1);

    // 4. A gift invoice on ANY other subscription (an operator's separate one) funds nothing.
    const before = await poolCents(org.orgId);
    const stray = invoiceObject({ customer: org.customerId, subscriptionId: 'sub_seat8_separate_gift', metadata: issued.metadata, extraSeats, paid: false, billingReason: 'subscription_cycle', periodStart: 1_800_000_000 + 80 * DAY });
    expect(await deliver('invoice.paid', stray)).toBe(200);
    expect(await poolCents(org.orgId)).toBe(before);
    const pool = await poolOf(org.orgId);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.walletId, pool!.id))).toHaveLength(2);
  });

  it('SEAT-8 (partial) D-OW-54 a gift is fixed at its pinned seats: an interrupted gift completes on retry with one coupon, throwaway invites cannot raise it or its funding, and a revoke takes it off so a re-gift reuses the coupon', async () => {
    if (!dbAvailable) return;
    const pinnedSeats = 2;
    const org = await northwind(TIER_PLAN_LIMITS.business.includedSeats + pinnedSeats);
    const meta = { kind: ORG_SUBSCRIPTION_KIND, [ORG_ID_METADATA_KEY]: org.orgId };
    org.stripe.payLatestInvoice(org.subscriptionId);
    const firstPaid = invoiceObject({ customer: org.customerId, subscriptionId: org.subscriptionId, metadata: meta, extraSeats: pinnedSeats, paid: true, billingReason: 'subscription_create', periodStart: 1_810_000_000 });
    expect(await deliver('invoice.paid', firstPaid)).toBe(200);
    expect((await getOrgStatus(org.orgId)).status).toBe('active');

    // Resumable: the coupon is created, then the subscription update fails. Nothing is pinned
    // (the transaction rolled back); a retry with another reason reuses the one coupon.
    const gift = new FakeGiftStripe(org.stripe);
    gift.failNextUpdate = new Error('An error occurred with our connection to Stripe.');
    await expect(giftOrgSubscription({ orgId: org.orgId, adminUserId: ADMIN_ID, reason: 'First try', extraSeats: pinnedSeats }, gift)).rejects.toThrow(/connection/);
    expect(gift.couponCreates).toBe(1);
    const [afterFailure] = await db.select({ giftedExtraSeats: orgSubscriptions.giftedExtraSeats }).from(orgSubscriptions).where(eq(orgSubscriptions.orgId, org.orgId));
    expect(afterFailure.giftedExtraSeats).toBeNull();
    expect(await giftOrgSubscription({ orgId: org.orgId, adminUserId: ADMIN_ID, reason: 'Second try, new reason', extraSeats: pinnedSeats }, gift)).toMatchObject({ kind: 'gifted', giftedExtraSeats: pinnedSeats });
    expect(gift.couponCreates).toBe(1);
    const sub = org.stripe.subscriptions.get(org.subscriptionId)!;
    expect(sub.items.find((i) => i.priceId === PRICES.seatPriceId)?.quantity).toBe(pinnedSeats);
    expect(await deliver('customer.subscription.updated', { id: org.subscriptionId, object: 'subscription', customer: org.customerId, status: sub.status, metadata: sub.metadata })).toBe(200);

    // The throwaway-invite attack: auto-add on, invites up to the gifted seats are admitted and
    // the next is refused — a gift is never raised.
    await db.update(organizations).set({ seatAutoAdd: true }).where(eq(organizations.id, org.orgId));
    const invite = (n: number) => ({
      orgId: org.orgId,
      email: `throwaway${n}-${Math.random().toString(36).slice(2, 8)}@example.test`,
      tokenHash: `seat8-${Math.random().toString(36).slice(2)}-${n}`,
      expiresAt: new Date(Date.now() + 7 * DAY * 1000),
    });
    // The Owner holds one seat; 6 live invites fill the 7 gifted seats.
    await db.insert(orgInvitations).values(Array.from({ length: TIER_PLAN_LIMITS.business.includedSeats + pinnedSeats - 1 }, (_, n) => invite(n)));
    const refused = await db.transaction((tx) => admitSeat(tx, { orgId: org.orgId, actorRole: 'OWNER' }));
    expect(refused).toMatchObject({ ok: false, status: 402, purchased: TIER_PLAN_LIMITS.business.includedSeats + pinnedSeats });
    expect(refused.ok === false && refused.message).toMatch(/gift/i);
    expect(sub.items.find((i) => i.priceId === PRICES.seatPriceId)?.quantity).toBe(pinnedSeats);

    // Even a gift invoice billing 10 extra seats (a quantity raised outside the app) funds only the pinned 2.
    const before = await poolCents(org.orgId);
    const inflated = invoiceObject({ customer: org.customerId, subscriptionId: org.subscriptionId, metadata: { ...sub.metadata }, extraSeats: 10, paid: false, billingReason: 'subscription_cycle', periodStart: 1_810_000_000 + 30 * DAY });
    expect(await deliver('invoice.paid', inflated)).toBe(200);
    expect((await poolCents(org.orgId)) - before).toBe(orgPoolListPriceGrantCents(pinnedSeats));

    // Revoke: the coupon and the gift metadata come off; the pin is released.
    expect(await ungiftOrgSubscription({ orgId: org.orgId, adminUserId: ADMIN_ID, reason: 'Partnership ended' }, gift)).toMatchObject({ kind: 'ungifted', subscriptionId: org.subscriptionId });
    expect(gift.discounts.get(org.subscriptionId)).toEqual([]);
    expect(sub.metadata?.type).toBeUndefined();
    expect(sub.metadata?.giftedExtraSeats).toBeUndefined();
    const [revoked] = await db.select({ gifted: orgSubscriptions.gifted, giftedExtraSeats: orgSubscriptions.giftedExtraSeats }).from(orgSubscriptions).where(eq(orgSubscriptions.orgId, org.orgId));
    expect(revoked).toEqual({ gifted: false, giftedExtraSeats: null });
    expect(await ungiftOrgSubscription({ orgId: org.orgId, adminUserId: ADMIN_ID, reason: 'again' }, gift)).toEqual({ kind: 'refused', reason: 'not_gifted' });

    // A re-gift reuses the subscription's coupon instead of colliding with it.
    expect(await giftOrgSubscription({ orgId: org.orgId, adminUserId: ADMIN_ID, reason: 'Back on', extraSeats: 3 }, gift)).toMatchObject({ kind: 'gifted', giftedExtraSeats: 3 });
    expect(gift.couponCreates).toBe(1);
    await db.delete(orgInvitations).where(eq(orgInvitations.orgId, org.orgId));
  });
});

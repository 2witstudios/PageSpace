// @vitest-environment node
/**
 * The Stripe webhook's ORG branch end to end: signed events through the real POST
 * handler, a REAL Postgres, and the in-memory Stripe (FakeOrgStripe) the org billing
 * shell reads the subscription from (Spec SEAT-7, SEAT-9, MON-3).
 *
 * Proves: an org's events never reach the personal handlers and a person's never reach
 * the org pool; a replayed event is a no-op (no Stripe read, no write); two concurrent
 * deliveries of one event apply once; two events about one invoice grant once; an older
 * invoice paid late never moves the pool's period back; a late event about an ended,
 * replaced subscription never overwrites the current one; lapse is entered and left by
 * the mirror alone and never touches a credit.
 *
 * Runs ARMED for the funding-legs invariant (D-OW-13), like lib's integration setup: every
 * connection of this file's pool turns the check on and the commit-time trigger is
 * installed, so ANY refill, mirror or fixture write that leaves a drive wallet's
 * topupRemainingCents != SUM(legs) fails its own transaction.
 *
 * Requires DATABASE_URL → a migrated Postgres (requireDb). Deletes every row it creates:
 * ledger, wallets and legs, org_subscriptions, members, orgs, then users.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Stripe from 'stripe';
import { db, pool as appPool } from '@pagespace/db/db';
import { and, eq, inArray, isNull, or, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { wallets, walletFundingLegs } from '@pagespace/db/schema/wallets';
import { creditLedger } from '@pagespace/db/schema/credits';
import { stripeEvents, subscriptions } from '@pagespace/db/schema/subscriptions';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { createOrganization } from '@pagespace/lib/organizations/repository';
import { getOrgStatus } from '@pagespace/lib/organizations/status';
import { ORG_ID_METADATA_KEY, ORG_SUBSCRIPTION_KIND, type OrgBusinessPrices } from '@pagespace/lib/billing/org-subscription-core';
import { orgPoolRefillGrant } from '@pagespace/lib/billing/wallet-funding';
import { centsFromDollars, tierListPriceCents } from '@pagespace/lib/billing/money-model';
import { TIER_PLAN_LIMITS } from '@pagespace/lib/billing/subscription-tiers';
import { stripeConfig } from '@/lib/stripe-config';
import { ensureOrgBusinessSubscription, type OrgBillingDeps, type OrgBillingStripe } from '@/lib/org-billing/org-subscription';
import { FakeOrgStripe } from '@/lib/org-billing/__tests__/fake-org-stripe';
import { WALLET_LEG_INVARIANT_GUC, expectWalletLegInvariant, installWalletLegInvariantTrigger } from '@pagespace/lib/test/wallet-leg-invariant';

// The webhook reads the subscription through stripeOrgBilling(appStripe); here it reads
// the in-memory Stripe of the org under test instead. Everything else is the real module.
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

import { POST } from '../route';
import { queryOrgAuditEvents } from '@pagespace/lib/audit/org-audit-query';
import { parseOrgAuditFilter } from '@pagespace/lib/audit/org-audit-query-core';

const WEBHOOK_SECRET = 'whsec_ow_d3_local_test_secret';
const PRICES: OrgBusinessPrices = { basePriceId: stripeConfig.orgPriceIds.businessBase, seatPriceId: stripeConfig.orgPriceIds.extraSeat };
const BASE_CENTS = tierListPriceCents('business');
const SEAT_CENTS = centsFromDollars(TIER_PLAN_LIMITS.business.extraSeatUsd);
const DAY = 86_400;

let dbAvailable = false;
const env = { mode: process.env.DEPLOYMENT_MODE, secret: process.env.STRIPE_WEBHOOK_SECRET, key: process.env.STRIPE_SECRET_KEY };
const orgIds: string[] = [];
const userIds: string[] = [];
const eventIds: string[] = [];
const signer = new Stripe('sk_test_signer_only_no_network');

// Arm D-OW-13 on every connection this file's pool opens, registered before its first
// query. A connection whose SET failed is remembered and thrown in beforeAll, never
// swallowed, so a broken harness fails loudly instead of checking nothing.
// The sessions also run in a NON-UTC zone on purpose: the stripe_events claim lease must
// not depend on the database session's TimeZone (review ow-irv-2739 P3-1), and the
// concurrent-delivery test reclaims the lease early if it does.
const SESSION_TIME_ZONE = 'America/Chicago';
let armFailure: unknown = null;
appPool.on('connect', (client) => {
  client.query(`SET ${WALLET_LEG_INVARIANT_GUC} = 'on'; SET TIME ZONE '${SESSION_TIME_ZONE}'`).catch((error: unknown) => {
    armFailure = error;
  });
});

interface Org {
  orgId: string;
  ownerId: string;
  customerId: string;
  subscriptionId: string;
  stripe: FakeOrgStripe;
  deps: OrgBillingDeps;
}

/** Northwind Labs with its own customer and trialing Business subscription (D1's path). */
async function northwind(seats = 7): Promise<Org> {
  const owner = await factories.createUser({ email: `jono+d3${Date.now()}${Math.random().toString(36).slice(2, 8)}@northwind.test`, name: 'Jono' });
  userIds.push(owner.id);
  const created = await createOrganization({ name: 'Northwind Labs', slug: `northwind-${Math.random().toString(36).slice(2, 10)}`, ownerId: owner.id });
  if (!created.ok) throw new Error(`org create failed: ${created.reason}`);
  orgIds.push(created.organization.id);
  const stripe = new FakeOrgStripe();
  const deps: OrgBillingDeps = { stripe, prices: () => PRICES, countSeats: async () => seats };
  const { linkage } = await ensureOrgBusinessSubscription(created.organization.id, deps);
  fakeHolder.current = stripe;
  return { orgId: created.organization.id, ownerId: owner.id, customerId: linkage.stripeCustomerId, subscriptionId: linkage.stripeSubscriptionId, stripe, deps };
}

function orgMetadata(orgId: string): Record<string, string> {
  return { kind: ORG_SUBSCRIPTION_KIND, [ORG_ID_METADATA_KEY]: orgId };
}

let seq = 0;
function evtId(): string {
  const id = `evt_owd3_${Date.now().toString(36)}_${(seq += 1)}_${Math.random().toString(36).slice(2, 8)}`;
  eventIds.push(id);
  return id;
}

interface InvoiceSpec {
  customer: string;
  subscriptionId: string;
  metadata: Record<string, string>;
  seats: number;
  paid: boolean;
  billingReason: 'subscription_create' | 'subscription_cycle';
  periodStart: number;
  invoiceId?: string;
}

function invoiceObject(spec: InvoiceSpec) {
  const periodEnd = spec.periodStart + 30 * DAY;
  const lines = [
    { amount: spec.paid ? BASE_CENTS : 0, discount_amounts: [], quantity: 1, pricing: { price_details: { price: PRICES.basePriceId } }, period: { start: spec.periodStart, end: periodEnd } },
    { amount: spec.paid ? SEAT_CENTS * spec.seats : 0, discount_amounts: [], quantity: spec.seats, pricing: { price_details: { price: PRICES.seatPriceId } }, period: { start: spec.periodStart, end: periodEnd } },
  ];
  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  return {
    id: spec.invoiceId ?? `in_owd3_${Math.random().toString(36).slice(2, 12)}`,
    object: 'invoice',
    currency: 'usd',
    customer: spec.customer,
    amount_paid: total,
    subtotal: total,
    billing_reason: spec.billingReason,
    period_start: spec.periodStart - 30 * DAY,
    period_end: spec.periodStart,
    livemode: false,
    parent: { type: 'subscription_details', subscription_details: { metadata: spec.metadata, subscription: spec.subscriptionId } },
    lines: { object: 'list', data: lines },
  };
}

function eventPayload(type: string, object: unknown, id = evtId()): string {
  return JSON.stringify({ id, object: 'event', type, created: Math.floor(Date.now() / 1000), livemode: false, api_version: '2026-02-25.clover', data: { object } });
}

async function deliver(payload: string): Promise<number> {
  const header = signer.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const request = new Request('https://example.com/api/stripe/webhook', { method: 'POST', body: payload, headers: { 'stripe-signature': header } });
  const response = await POST(request as unknown as import('next/server').NextRequest);
  return response.status;
}

async function poolOf(orgId: string) {
  const [pool] = await db
    .select()
    .from(wallets)
    .where(and(eq(wallets.orgId, orgId), eq(wallets.ownerType, 'org'), isNull(wallets.subjectType), isNull(wallets.parentWalletId)));
  return pool ?? null;
}

async function ledgerRows(walletId: string) {
  return db.select().from(creditLedger).where(eq(creditLedger.walletId, walletId));
}

async function storedSub(orgId: string) {
  const [row] = await db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId));
  return row;
}

/**
 * An org drive wallet under the pool holding `topupCents` on one owner leg. Wallet and leg
 * are written in ONE transaction: the armed trigger checks D-OW-13 at commit, and a wallet
 * committed before its leg would (rightly) be refused.
 */
async function seedDriveWallet(orgId: string, poolId: string, topupCents: number) {
  return db.transaction(async (tx) => {
    const [driveWallet] = await tx
      .insert(wallets)
      .values({ ownerType: 'org', orgId, subjectType: 'drive', subjectId: `drv_owd3_${Math.random().toString(36).slice(2, 10)}`, parentWalletId: poolId, topupRemainingCents: topupCents, monthlyAllowanceCents: 1200, monthlyRemainingCents: 1200 })
      .returning();
    await tx.insert(walletFundingLegs).values({ walletId: driveWallet.id, funderKind: 'owner', funderOrgId: orgId, originalCents: topupCents, remainingCents: topupCents, nonRefundable: false });
    return driveWallet;
  });
}

function setStripeStatus(org: Org, status: string, extra: Partial<{ trialEnd: number | null }> = {}): void {
  const sub = org.stripe.subscriptions.get(org.subscriptionId);
  if (!sub) throw new Error('no fake subscription');
  sub.status = status;
  if ('trialEnd' in extra) sub.trialEnd = extra.trialEnd ?? null;
}

describe('Stripe webhook — org routing, idempotency, lapse (real Postgres, in-memory Stripe)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('org-webhook.integration.test.ts', error);
      dbAvailable = false;
    }
    process.env.DEPLOYMENT_MODE = 'cloud';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    // constructEvent is a local HMAC check; the app client needs a key to exist, never a real one here.
    if (!process.env.STRIPE_SECRET_KEY) process.env.STRIPE_SECRET_KEY = 'sk_test_signature_only';
    if (!dbAvailable) return;
    await installWalletLegInvariantTrigger(appPool);
    // Prove the arming on EVERY connection the pool holds (checked out at once, so no idle
    // one is skipped), rather than trust the hook ran.
    const clients = await Promise.all(Array.from({ length: Math.max(appPool.totalCount, 1) }, () => appPool.connect()));
    try {
      const armed = await Promise.all(
        clients.map(async (c) => (await c.query<{ armed: string | null; tz: string }>(`SELECT current_setting('${WALLET_LEG_INVARIANT_GUC}', true) AS armed, current_setting('TimeZone') AS tz`)).rows[0]),
      );
      if (armed.some((a) => a?.armed !== 'on')) throw new Error(`wallet-leg invariant is not armed on every connection: ${JSON.stringify(armed)}`);
      if (armed.some((a) => a?.tz !== SESSION_TIME_ZONE)) throw new Error(`session TimeZone is not ${SESSION_TIME_ZONE} on every connection: ${JSON.stringify(armed)}`);
    } finally {
      for (const c of clients) c.release();
    }
    if (armFailure) throw armFailure;
  });

  afterEach(() => {
    fakeHolder.current = null;
  });

  afterAll(async () => {
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('DEPLOYMENT_MODE', env.mode);
    restore('STRIPE_WEBHOOK_SECRET', env.secret);
    restore('STRIPE_SECRET_KEY', env.key);
    if (!dbAvailable) return;
    if (eventIds.length > 0) await db.delete(stripeEvents).where(inArray(stripeEvents.id, eventIds));
    const ownedWallets = await db
      .select({ id: wallets.id })
      .from(wallets)
      .where(or(orgIds.length ? inArray(wallets.orgId, orgIds) : sql`false`, userIds.length ? inArray(wallets.userId, userIds) : sql`false`));
    const walletIds = ownedWallets.map((w) => w.id);
    if (walletIds.length > 0) {
      await db.delete(creditLedger).where(inArray(creditLedger.walletId, walletIds));
      // Funding legs cascade with their wallet (deleting a leg first would break D-OW-13's
      // invariant under an armed harness). Children (drive wallets) before their parent pool.
      await db.delete(wallets).where(and(inArray(wallets.id, walletIds), sql`${wallets.parentWalletId} is not null`));
      await db.delete(wallets).where(inArray(wallets.id, walletIds));
    }
    if (userIds.length > 0) await db.delete(creditLedger).where(inArray(creditLedger.userId, userIds));
    if (orgIds.length > 0) {
      await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  });

  it("SEAT-7 (partial) org subscription webhooks are routed to the org before the personal-tier handler and are idempotent: each event delivered twice applies once and never touches the Owner's personal plan", async () => {
    if (!dbAvailable) return;
    const org = await northwind(7);
    // The Owner is also a paying personal customer: the personal handler must never see the org's events.
    const ownerCustomer = `cus_owd3_owner_${Math.random().toString(36).slice(2, 10)}`;
    await db.update(users).set({ stripeCustomerId: ownerCustomer, subscriptionTier: 'pro' }).where(eq(users.id, org.ownerId));
    const personalSubsBefore = await db.select().from(subscriptions).where(eq(subscriptions.userId, org.ownerId));

    // customer.subscription.updated → mirrored onto org_subscriptions (the org's handler).
    setStripeStatus(org, 'active');
    const updated = eventPayload('customer.subscription.updated', { id: org.subscriptionId, object: 'subscription', customer: org.customerId, status: 'active', metadata: orgMetadata(org.orgId) });
    expect(await deliver(updated)).toBe(200);
    expect((await storedSub(org.orgId)).status).toBe('active');
    const readsAfterUpdate = org.stripe.reads.retrieveSubscription;
    const rowAfterUpdate = await storedSub(org.orgId);
    expect(await deliver(updated)).toBe(200);
    expect(org.stripe.reads.retrieveSubscription).toBe(readsAfterUpdate);
    expect((await storedSub(org.orgId)).updatedAt).toEqual(rowAfterUpdate.updatedAt);

    // invoice.paid → the org pool (the org's handler), once.
    const paid = eventPayload(
      'invoice.paid',
      invoiceObject({ customer: org.customerId, subscriptionId: org.subscriptionId, metadata: orgMetadata(org.orgId), seats: 2, paid: true, billingReason: 'subscription_cycle', periodStart: 1_800_000_000 + 30 * DAY }),
    );
    expect(await deliver(paid)).toBe(200);
    expect(await deliver(paid)).toBe(200);
    const pool = await poolOf(org.orgId);
    expect(await ledgerRows(pool!.id)).toHaveLength(1);

    // customer.subscription.deleted → the ORG lapses; the personal handler would have set the Owner to free.
    org.stripe.endSubscription(org.subscriptionId, 'canceled');
    const deleted = eventPayload('customer.subscription.deleted', { id: org.subscriptionId, object: 'subscription', customer: org.customerId, status: 'canceled', metadata: orgMetadata(org.orgId) });
    expect(await deliver(deleted)).toBe(200);
    expect(await deliver(deleted)).toBe(200);
    expect((await getOrgStatus(org.orgId)).status).toBe('lapsed');

    // The personal-tier handler never ran: the Owner's tier, personal subscriptions and personal ledger are untouched.
    const [owner] = await db.select({ tier: users.subscriptionTier, customer: users.stripeCustomerId }).from(users).where(eq(users.id, org.ownerId));
    expect(owner).toEqual({ tier: 'pro', customer: ownerCustomer });
    expect(await db.select().from(subscriptions).where(eq(subscriptions.userId, org.ownerId))).toEqual(personalSubsBefore);
    expect(await db.select().from(creditLedger).where(and(eq(creditLedger.userId, org.ownerId), sql`${creditLedger.walletId} <> ${pool!.id}`))).toHaveLength(0);
  });

  it('AUD-1 (partial) billing events reach the org audit log once per real change: provisioning, each status change, the pool refill; a redelivery writes nothing', async () => {
    if (!dbAvailable) return;
    const org = await northwind(7);
    const billingTypes = async () => {
      const parsed = parseOrgAuditFilter({ category: 'billing', limit: '100' });
      if (!parsed.ok) throw new Error(parsed.error);
      return (await queryOrgAuditEvents(org.orgId, parsed.filter)).entries.map((e) => [e.eventType, e.details.to ?? null]);
    };
    // Provisioning wrote the subscription's start.
    expect(await billingTypes()).toEqual([['org.billing.subscription_changed', 'trialing']]);

    setStripeStatus(org, 'active');
    const updated = eventPayload('customer.subscription.updated', { id: org.subscriptionId, object: 'subscription', customer: org.customerId, status: 'active', metadata: orgMetadata(org.orgId) });
    expect(await deliver(updated)).toBe(200);
    expect(await deliver(updated)).toBe(200);
    const paid = eventPayload(
      'invoice.paid',
      invoiceObject({ customer: org.customerId, subscriptionId: org.subscriptionId, metadata: orgMetadata(org.orgId), seats: 2, paid: true, billingReason: 'subscription_cycle', periodStart: 1_800_000_000 + 30 * DAY }),
    );
    expect(await deliver(paid)).toBe(200);
    expect(await deliver(paid)).toBe(200);
    org.stripe.endSubscription(org.subscriptionId, 'canceled');
    const deleted = eventPayload('customer.subscription.deleted', { id: org.subscriptionId, object: 'subscription', customer: org.customerId, status: 'canceled', metadata: orgMetadata(org.orgId) });
    expect(await deliver(deleted)).toBe(200);

    expect(await billingTypes()).toEqual([
      ['org.billing.subscription_changed', 'canceled'],
      ['org.billing.pool_refilled', null],
      ['org.billing.subscription_changed', 'active'],
      ['org.billing.subscription_changed', 'trialing'],
    ]);
  });

  it('SEAT-7 (partial) MON-3 (partial) replaying the same org invoice.paid event is a no-op: one grant, no second Stripe read, no second write', async () => {
    if (!dbAvailable) return;
    const org = await northwind(7);
    const invoice = invoiceObject({
      customer: org.customerId,
      subscriptionId: org.subscriptionId,
      metadata: orgMetadata(org.orgId),
      seats: 2,
      paid: false,
      billingReason: 'subscription_create',
      periodStart: 1_800_000_000,
    });
    const payload = eventPayload('invoice.paid', invoice);
    // The grant the one funding path makes for this invoice: a trial at list price × ratio for the 2 seats it billed ([D-OW-23]).
    const expected = orgPoolRefillGrant({
      lines: invoice.lines.data,
      amountPaidCents: 0,
      hasSubscriptionParent: true,
      billingReason: 'subscription_create',
      subtotalCents: 0,
      extraSeats: 2,
    }).allowanceCents;
    expect(expected).toBeGreaterThan(0);

    expect(await deliver(payload)).toBe(200);
    const pool = await poolOf(org.orgId);
    expect(pool?.monthlyRemainingCents).toBe(expected);
    expect(await ledgerRows(pool!.id)).toHaveLength(1);
    // A funded drive wallet under the pool, so the replay has a non-root wallet to keep whole.
    const driveWallet = await seedDriveWallet(org.orgId, pool!.id, 300);
    const readsAfterFirst = org.stripe.reads.retrieveSubscription;
    const rowAfterFirst = await storedSub(org.orgId);

    expect(await deliver(payload)).toBe(200);
    expect((await poolOf(org.orgId))?.monthlyRemainingCents).toBe(expected);
    expect(await ledgerRows(pool!.id)).toHaveLength(1);
    expect(org.stripe.reads.retrieveSubscription).toBe(readsAfterFirst);
    expect((await storedSub(org.orgId)).updatedAt).toEqual(rowAfterFirst.updatedAt);
    await expectWalletLegInvariant([driveWallet.id]);
  });

  it('SEAT-7 (partial) two CONCURRENT deliveries of the same event cannot both apply: one runs, the other is told to retry, and the retry is acked', async () => {
    if (!dbAvailable) return;
    const org = await northwind(7);
    // Widen the window: the first delivery holds its claim while it reads Stripe.
    const slow = org.stripe.retrieveSubscription.bind(org.stripe);
    org.stripe.retrieveSubscription = async (id: string) => {
      await new Promise((r) => setTimeout(r, 300));
      return slow(id);
    };
    const invoice = invoiceObject({
      customer: org.customerId,
      subscriptionId: org.subscriptionId,
      metadata: orgMetadata(org.orgId),
      seats: 2,
      paid: true,
      billingReason: 'subscription_cycle',
      periodStart: 1_800_000_000 + 30 * DAY,
    });
    const payload = eventPayload('invoice.paid', invoice);

    const statuses = await Promise.all([deliver(payload), deliver(payload)]);
    expect([...statuses].sort()).toEqual([200, 500]);
    const pool = await poolOf(org.orgId);
    expect(await ledgerRows(pool!.id)).toHaveLength(1);
    expect(org.stripe.reads.retrieveSubscription).toBe(1);

    // Stripe redelivers the one that was told to retry: acked, nothing applied twice.
    expect(await deliver(payload)).toBe(200);
    expect(await ledgerRows(pool!.id)).toHaveLength(1);
    expect(org.stripe.reads.retrieveSubscription).toBe(1);
  });

  it('SEAT-7 (partial) MON-3 (partial) two DIFFERENT events about one invoice, delivered concurrently, grant it once', async () => {
    if (!dbAvailable) return;
    const org = await northwind(7);
    const invoice = invoiceObject({
      customer: org.customerId,
      subscriptionId: org.subscriptionId,
      metadata: orgMetadata(org.orgId),
      seats: 2,
      paid: true,
      billingReason: 'subscription_cycle',
      periodStart: 1_800_000_000 + 30 * DAY,
    });
    const statuses = await Promise.all([deliver(eventPayload('invoice.paid', invoice)), deliver(eventPayload('invoice.paid', invoice))]);
    expect(statuses).toEqual([200, 200]);
    const pool = await poolOf(org.orgId);
    const rows = await ledgerRows(pool!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].stripeRef).toBe(invoice.id);
    expect(pool?.monthlyRemainingCents).toBe(rows[0].amountCents);
  });

  it('SEAT-7 (partial) an OLDER invoice paid after a newer one is funded once but never moves the pool period back (#2718 P2-2)', async () => {
    if (!dbAvailable) return;
    const org = await northwind(7);
    const october = 1_800_000_000 + 30 * DAY;
    const november = october + 30 * DAY;
    const base = { customer: org.customerId, subscriptionId: org.subscriptionId, metadata: orgMetadata(org.orgId), seats: 2, paid: true, billingReason: 'subscription_cycle' as const };
    expect(await deliver(eventPayload('invoice.paid', invoiceObject({ ...base, periodStart: november })))).toBe(200);
    const afterNewer = await poolOf(org.orgId);
    expect(afterNewer?.monthlyPeriodStart?.getTime()).toBe(november * 1000);

    expect(await deliver(eventPayload('invoice.paid', invoiceObject({ ...base, periodStart: october })))).toBe(200);
    const afterOlder = await poolOf(org.orgId);
    expect(afterOlder?.monthlyPeriodStart?.getTime()).toBe(november * 1000);
    expect(afterOlder?.monthlyPeriodEnd?.getTime()).toBe((november + 30 * DAY) * 1000);
    // Both were paid, so both fund — additively, never by overwriting the newer grant.
    const rows = await ledgerRows(afterOlder!.id);
    expect(rows).toHaveLength(2);
    expect(afterOlder?.monthlyRemainingCents).toBe(rows[0].amountCents + rows[1].amountCents);
  });

  it('MON-3 (partial) an OLDER invoice for fewer seats paid late adds its credits once but never steps the current allowance back (ow-irv-2739 P3-2)', async () => {
    if (!dbAvailable) return;
    const org = await northwind(7);
    const october = 1_800_000_000 + 30 * DAY;
    const november = october + 30 * DAY;
    const base = { customer: org.customerId, subscriptionId: org.subscriptionId, metadata: orgMetadata(org.orgId), paid: true, billingReason: 'subscription_cycle' as const };
    // Seats grew between the periods: October billed 1 extra seat, November 4.
    expect(await deliver(eventPayload('invoice.paid', invoiceObject({ ...base, seats: 4, periodStart: november })))).toBe(200);
    const afterNewer = (await poolOf(org.orgId))!;
    expect(await deliver(eventPayload('invoice.paid', invoiceObject({ ...base, seats: 1, periodStart: october })))).toBe(200);
    const afterOlder = (await poolOf(org.orgId))!;

    const rows = await ledgerRows(afterOlder.id);
    expect(rows).toHaveLength(2);
    const [novemberGrant, octoberGrant] = [rows.find((r) => r.amountCents === afterNewer.monthlyAllowanceCents), rows.find((r) => r.amountCents !== afterNewer.monthlyAllowanceCents)];
    // Non-vacuity: the two periods really grant different amounts.
    expect(novemberGrant).toBeDefined();
    expect(octoberGrant).toBeDefined();
    expect(octoberGrant!.amountCents).toBeLessThan(novemberGrant!.amountCents);
    // The current (November) allowance stands; October's credits are added, once.
    expect(afterOlder.monthlyAllowanceCents).toBe(afterNewer.monthlyAllowanceCents);
    expect(afterOlder.monthlyRemainingCents).toBe(novemberGrant!.amountCents + octoberGrant!.amountCents);
    expect(afterOlder.monthlyPeriodStart?.getTime()).toBe(november * 1000);
  });

  it("SEAT-7 (partial) a person's invoice never funds an org pool, and an org-tagged invoice on a person's customer funds nobody", async () => {
    if (!dbAvailable) return;
    const org = await northwind(7);
    const person = await factories.createUser({ email: `marcus+d3${Date.now()}@northwind.test`, name: 'Marcus Oyelaran', stripeCustomerId: `cus_owd3_person_${Math.random().toString(36).slice(2, 10)}` });
    userIds.push(person.id);

    // Tagged as Northwind's, but on Marcus's customer: applied nowhere.
    const tagged = invoiceObject({
      customer: person.stripeCustomerId!,
      subscriptionId: 'sub_owd3_foreign',
      metadata: orgMetadata(org.orgId),
      seats: 2,
      paid: true,
      billingReason: 'subscription_cycle',
      periodStart: 1_800_000_000,
    });
    expect(await deliver(eventPayload('invoice.paid', tagged))).toBe(200);
    expect(await poolOf(org.orgId)).toBeNull();
    expect(await db.select().from(creditLedger).where(eq(creditLedger.userId, person.id))).toHaveLength(0);

    // Marcus's own Pro invoice ($15, the personal Pro price; unit_amount_decimal is CENTS):
    // the personal path funds HIS wallet, and never Northwind's pool.
    const proCents = tierListPriceCents('pro');
    const personal = {
      id: `in_owd3_${Math.random().toString(36).slice(2, 12)}`,
      object: 'invoice',
      currency: 'usd',
      customer: person.stripeCustomerId!,
      amount_paid: proCents,
      subtotal: proCents,
      billing_reason: 'subscription_cycle',
      period_start: 1_800_000_000 - 30 * DAY,
      period_end: 1_800_000_000,
      livemode: false,
      parent: { type: 'subscription_details', subscription_details: { metadata: {}, subscription: 'sub_owd3_personal' } },
      lines: {
        object: 'list',
        data: [
          {
            amount: proCents,
            discount_amounts: [],
            quantity: 1,
            pricing: { price_details: { price: stripeConfig.priceIds.pro }, unit_amount_decimal: String(proCents) },
            period: { start: 1_800_000_000, end: 1_800_000_000 + 30 * DAY },
          },
        ],
      },
    };
    expect(await deliver(eventPayload('invoice.paid', personal))).toBe(200);
    expect(await poolOf(org.orgId)).toBeNull();
    const personalRows = await db.select().from(creditLedger).where(eq(creditLedger.stripeRef, personal.id));
    expect(personalRows.length).toBeGreaterThan(0);
    const [marcusRoot] = await db.select({ id: wallets.id }).from(wallets).where(and(eq(wallets.userId, person.id), isNull(wallets.subjectType), isNull(wallets.parentWalletId)));
    for (const row of personalRows) {
      expect(row.userId).toBe(person.id);
      expect(row.walletId).toBe(marcusRoot.id);
    }
    expect(personalRows.reduce((sum, r) => sum + r.amountCents, 0)).toBeGreaterThan(0);

    // An org's invoice tagged for ANOTHER org: refused, the customer's org is not funded either.
    const mismatch = invoiceObject({
      customer: org.customerId,
      subscriptionId: org.subscriptionId,
      metadata: orgMetadata('org_someone_else'),
      seats: 2,
      paid: true,
      billingReason: 'subscription_cycle',
      periodStart: 1_800_000_000,
    });
    expect(mismatch.amount_paid).toBeGreaterThan(0);
    expect(await deliver(eventPayload('invoice.paid', mismatch))).toBe(200);
    expect(await poolOf(org.orgId)).toBeNull();
  });

  it('SEAT-7 (partial) an event for a customer that is nobody we know changes nothing and is acked', async () => {
    if (!dbAvailable) return;
    const unknown = invoiceObject({
      customer: `cus_owd3_nobody_${Math.random().toString(36).slice(2, 10)}`,
      subscriptionId: 'sub_owd3_nobody',
      metadata: {},
      seats: 0,
      paid: true,
      billingReason: 'subscription_cycle',
      periodStart: 1_800_000_000,
    });
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(creditLedger).where(eq(creditLedger.stripeRef, unknown.id));
    expect(await deliver(eventPayload('invoice.paid', unknown))).toBe(200);
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(creditLedger).where(eq(creditLedger.stripeRef, unknown.id));
    expect(after[0].n).toBe(before[0].n);
  });

  it('SEAT-9 (partial) SEAT-7 (partial) a subscription event mirrors what Stripe says NOW, so an out-of-order snapshot cannot roll the org back', async () => {
    if (!dbAvailable) return;
    const org = await northwind(7);
    setStripeStatus(org, 'active');
    // An older event whose snapshot still says past_due arrives after Stripe moved on.
    const staleSnapshot = { id: org.subscriptionId, object: 'subscription', customer: org.customerId, status: 'past_due', metadata: orgMetadata(org.orgId) };
    expect(await deliver(eventPayload('customer.subscription.updated', staleSnapshot))).toBe(200);
    expect((await storedSub(org.orgId)).status).toBe('active');
    expect((await getOrgStatus(org.orgId)).status).toBe('active');
  });

  it('SEAT-9 (partial) entering and leaving lapse is explicit and reversible, and never touches a credit already granted', async () => {
    if (!dbAvailable) return;
    const org = await northwind(7);
    const snapshot = { id: org.subscriptionId, object: 'subscription', customer: org.customerId, metadata: orgMetadata(org.orgId) };
    // Fund the pool and give a drive wallet a funding leg, so there are credits to protect.
    expect(
      await deliver(
        eventPayload(
          'invoice.paid',
          invoiceObject({ customer: org.customerId, subscriptionId: org.subscriptionId, metadata: orgMetadata(org.orgId), seats: 2, paid: true, billingReason: 'subscription_cycle', periodStart: 1_800_000_000 + 30 * DAY }),
        ),
      ),
    ).toBe(200);
    const pool = (await poolOf(org.orgId))!;
    const driveWallet = await seedDriveWallet(org.orgId, pool.id, 500);
    const snapshotOf = async () =>
      (await db.select().from(wallets).where(eq(wallets.orgId, org.orgId))).map((w) => ({ id: w.id, m: w.monthlyRemainingCents, t: w.topupRemainingCents, d: w.debtCents, s: w.status })).sort((a, b) => a.id.localeCompare(b.id));
    const legsOf = async () => (await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, driveWallet.id))).map((l) => l.remainingCents);
    const walletsBefore = await snapshotOf();
    const legsBefore = await legsOf();

    setStripeStatus(org, 'active');
    expect(await deliver(eventPayload('customer.subscription.updated', { ...snapshot, status: 'active' }))).toBe(200);
    expect((await getOrgStatus(org.orgId)).status).toBe('active');

    // A failed payment: past_due keeps the org working.
    setStripeStatus(org, 'past_due');
    expect(await deliver(eventPayload('invoice.payment_failed', invoiceObject({ customer: org.customerId, subscriptionId: org.subscriptionId, metadata: orgMetadata(org.orgId), seats: 2, paid: false, billingReason: 'subscription_cycle', periodStart: 1_800_000_000 + 60 * DAY })))).toBe(200);
    expect(await getOrgStatus(org.orgId)).toEqual({ status: 'past_due', reason: null });

    // Dunning gives up: unpaid → lapsed.
    setStripeStatus(org, 'unpaid');
    expect(await deliver(eventPayload('customer.subscription.updated', { ...snapshot, status: 'unpaid' }))).toBe(200);
    expect(await getOrgStatus(org.orgId)).toEqual({ status: 'lapsed', reason: 'unpaid' });
    expect(await snapshotOf()).toEqual(walletsBefore);
    expect(await legsOf()).toEqual(legsBefore);
    await expectWalletLegInvariant([driveWallet.id]);

    // The card works again: the paid invoice lifts the lapse, and the credits are exactly where they were plus the new grant.
    setStripeStatus(org, 'active');
    const recovery = invoiceObject({ customer: org.customerId, subscriptionId: org.subscriptionId, metadata: orgMetadata(org.orgId), seats: 2, paid: true, billingReason: 'subscription_cycle', periodStart: 1_800_000_000 + 60 * DAY });
    expect(await deliver(eventPayload('invoice.paid', recovery))).toBe(200);
    expect((await getOrgStatus(org.orgId)).status).toBe('active');
    const [driveAfter] = await db.select().from(wallets).where(eq(wallets.id, driveWallet.id));
    expect(driveAfter.topupRemainingCents).toBe(500);
    expect(driveAfter.monthlyRemainingCents).toBe(1200);
    expect(await legsOf()).toEqual(legsBefore);
    await expectWalletLegInvariant([driveWallet.id]);
  });

  it('SEAT-9 (partial) a canceled subscription lapses the org; a late event about that ENDED subscription never lapses its replacement', async () => {
    if (!dbAvailable) return;
    const org = await northwind(7);
    const oldId = org.subscriptionId;
    org.stripe.endSubscription(oldId, 'canceled');
    const deleted = { id: oldId, object: 'subscription', customer: org.customerId, status: 'canceled', metadata: orgMetadata(org.orgId) };
    expect(await deliver(eventPayload('customer.subscription.deleted', deleted))).toBe(200);
    expect((await getOrgStatus(org.orgId)).status).toBe('lapsed');

    // Reactivate: D1's path creates the replacement (no second trial) and stores it.
    const { linkage } = await ensureOrgBusinessSubscription(org.orgId, org.deps);
    expect(linkage.stripeSubscriptionId).not.toBe(oldId);
    const replacement = org.stripe.subscriptions.get(linkage.stripeSubscriptionId)!;
    replacement.status = 'active';
    expect(await deliver(eventPayload('customer.subscription.updated', { id: replacement.id, object: 'subscription', customer: org.customerId, status: 'active', metadata: orgMetadata(org.orgId) }))).toBe(200);
    expect((await getOrgStatus(org.orgId)).status).toBe('active');

    // Stripe redelivers the old deletion late (a different event id): it must not touch the new row.
    expect(await deliver(eventPayload('customer.subscription.deleted', deleted))).toBe(200);
    expect((await storedSub(org.orgId)).stripeSubscriptionId).toBe(replacement.id);
    expect((await getOrgStatus(org.orgId)).status).toBe('active');
  });

  it("SEAT-7 (partial) an org's subscription events never write a person's tier, even when the Owner has a personal customer", async () => {
    if (!dbAvailable) return;
    const org = await northwind(7);
    await db.update(users).set({ stripeCustomerId: `cus_owd3_owner_${Math.random().toString(36).slice(2, 10)}`, subscriptionTier: 'pro' }).where(eq(users.id, org.ownerId));
    org.stripe.endSubscription(org.subscriptionId, 'canceled');
    expect(await deliver(eventPayload('customer.subscription.deleted', { id: org.subscriptionId, object: 'subscription', customer: org.customerId, status: 'canceled', metadata: orgMetadata(org.orgId) }))).toBe(200);
    const [owner] = await db.select({ tier: users.subscriptionTier }).from(users).where(eq(users.id, org.ownerId));
    expect(owner.tier).toBe('pro');
  });
});

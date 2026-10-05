// @vitest-environment node
/**
 * The webhook's org branch with REAL Stripe TEST events (Spec SEAT-7, SEAT-9, MON-3):
 * a Northwind org gets its Business subscription through D1's shell (no trial, [D-OW-30]:
 * it waits on its first invoice), the first invoice is paid by confirming a TEST card
 * with the client secret the shell hands out, then the events Stripe itself emitted for
 * it (invoice.paid for that first real payment, and customer.subscription.deleted after
 * a cancel) are read back from the events API,
 * signed with a local secret, and delivered to the real POST handler — twice, and
 * concurrently — against a real Postgres. The handler re-reads the subscription from
 * the Stripe TEST API.
 *
 * Runs only when STRIPE_TEST_SECRET_KEY is set, and refuses to run unless it is a TEST
 * key (sk_test_…). The app's client is pointed at that key for this process only. Every
 * Stripe customer it creates is named "[ow-d3 test <run>]" and deleted in afterAll
 * (deleting a customer cancels its subscriptions); every database row is deleted
 * children first, users last.
 *
 * Local run:
 *   STRIPE_TEST_SECRET_KEY=sk_test_… DATABASE_URL=… bunx vitest run <this file>
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Stripe from 'stripe';
import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNull } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { creditLedger } from '@pagespace/db/schema/credits';
import { stripeEvents } from '@pagespace/db/schema/subscriptions';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { createOrganization } from '@pagespace/lib/organizations/repository';
import { getOrgStatus } from '@pagespace/lib/organizations/status';
import { orgPoolRefillGrant } from '@pagespace/lib/billing/wallet-funding';
import type { OrgBusinessPrices } from '@pagespace/lib/billing/org-subscription-core';
import { stripeConfig, stripeMode } from '@/lib/stripe-config';
import { provisionOrgSubscription, stripeOrgBilling } from '@/lib/org-billing/org-subscription';
import { POST } from '../route';

const TEST_KEY = process.env.STRIPE_TEST_SECRET_KEY;
const RUN = `ow-d3 test ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const WEBHOOK_SECRET = 'whsec_ow_d3_live_replay_local_only';
const PRICES: OrgBusinessPrices = { basePriceId: stripeConfig.orgPriceIds.businessBase, seatPriceId: stripeConfig.orgPriceIds.extraSeat };
const env = { mode: process.env.DEPLOYMENT_MODE, secret: process.env.STRIPE_WEBHOOK_SECRET, key: process.env.STRIPE_SECRET_KEY };

let client: Stripe;
const orgIds: string[] = [];
const userIds: string[] = [];
const customerIds = new Set<string>();
const eventIds = new Set<string>();

/** The event Stripe emitted for this customer, read back from the events API (it lags a few seconds). */
async function realEvent(type: string, customerId: string, since: number): Promise<Stripe.Event> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const page = await client.events.list({ type, created: { gte: since }, limit: 100 });
    const found = page.data.find((e) => (e.data.object as { customer?: unknown }).customer === customerId);
    if (found) {
      eventIds.add(found.id);
      return found;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Stripe emitted no ${type} for ${customerId} within 30 s`);
}

async function deliver(event: Stripe.Event): Promise<number> {
  const payload = JSON.stringify(event);
  const header = client.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
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

describe.skipIf(!TEST_KEY)('Stripe webhook org branch with real Stripe TEST events', { timeout: 90_000 }, () => {
  beforeAll(async () => {
    if (!TEST_KEY?.startsWith('sk_test_')) throw new Error('STRIPE_TEST_SECRET_KEY must be a Stripe TEST key (sk_test_…); refusing to run');
    expect(stripeMode).toBe('test');
    try {
      await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).limit(1);
    } catch (error) {
      requireDb('org-webhook.stripe.integration.test.ts', error);
      throw error;
    }
    client = new Stripe(TEST_KEY, { apiVersion: '2026-02-25.clover' });
    process.env.DEPLOYMENT_MODE = 'cloud';
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
    // The route's own client (retrieve only) uses the same TEST key in this process.
    process.env.STRIPE_SECRET_KEY = TEST_KEY;
  });

  afterAll(async () => {
    for (const id of customerIds) await client.customers.del(id).catch(() => undefined);
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    restore('DEPLOYMENT_MODE', env.mode);
    restore('STRIPE_WEBHOOK_SECRET', env.secret);
    restore('STRIPE_SECRET_KEY', env.key);
    if (eventIds.size > 0) await db.delete(stripeEvents).where(inArray(stripeEvents.id, [...eventIds]));
    const owned = orgIds.length ? await db.select({ id: wallets.id }).from(wallets).where(inArray(wallets.orgId, orgIds)) : [];
    if (owned.length > 0) {
      await db.delete(creditLedger).where(inArray(creditLedger.walletId, owned.map((w) => w.id)));
      await db.delete(wallets).where(inArray(wallets.id, owned.map((w) => w.id)));
    }
    if (orgIds.length > 0) {
      await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  });

  it('SEAT-7 (partial) SEAT-9 (partial) MON-3 (partial) SEAT-8 (partial) D-OW-30 the first real payment (a card confirmed with the client secret) funds the org pool from what it paid, once, under a twice-and-concurrent real invoice.paid; a real subscription.deleted replayed lapses the org once', async () => {
    const owner = await factories.createUser({ email: `jono+${RUN.replace(/\W/g, '')}@northwind.test`, name: 'Jono' });
    userIds.push(owner.id);
    const created = await createOrganization({ name: `Northwind Labs [${RUN}]`, slug: `northwind-${Math.random().toString(36).slice(2, 10)}`, ownerId: owner.id });
    if (!created.ok) throw new Error(`org create failed: ${created.reason}`);
    const orgId = created.organization.id;
    orgIds.push(orgId);

    const since = Math.floor(Date.now() / 1000) - 5;
    // 7 seats → 2 extra seats on the first invoice (A-8); nothing is paid yet and nothing is granted.
    const deps = { stripe: stripeOrgBilling(client), prices: () => PRICES, countSeats: async () => 7 };
    const { result, payment } = await provisionOrgSubscription(orgId, deps);
    const linkage = result.linkage;
    customerIds.add(linkage.stripeCustomerId);
    expect(linkage.status).toBe('incomplete');
    expect(await poolOf(orgId)).toBeNull();
    expect((await getOrgStatus(orgId)).status).toBe('lapsed');
    if (payment.kind !== 'confirm_payment') throw new Error('no payment step');

    // What the client's Payment Element does with the secret: confirm a TEST card. Nothing is paid out of band.
    const intent = await client.paymentIntents.confirm(payment.clientSecret.split('_secret_')[0], { payment_method: 'pm_card_visa', return_url: 'https://app.pagespace.test/return' });
    expect(intent.status).toBe('succeeded');

    const paid = await realEvent('invoice.paid', linkage.stripeCustomerId, since);
    expect(paid.livemode).toBe(false);
    const invoice = paid.data.object as Stripe.Invoice;
    expect(invoice.billing_reason).toBe('subscription_create');
    expect(invoice.amount_paid).toBe(7000);

    // Two concurrent deliveries, then a late redelivery: one grant.
    const statuses = await Promise.all([deliver(paid), deliver(paid)]);
    expect(statuses).toContain(200);
    expect(statuses.every((s) => s === 200 || s === 500)).toBe(true);
    expect(await deliver(paid)).toBe(200);
    const pool = await poolOf(orgId);
    // [D-OW-30]: the pool is funded from the first REAL payment — what it paid × ratio, through the one funding path.
    const expected = orgPoolRefillGrant({
      lines: invoice.lines.data,
      amountPaidCents: invoice.amount_paid,
      hasSubscriptionParent: true,
      billingReason: invoice.billing_reason,
      subtotalCents: invoice.subtotal,
      extraSeats: 2,
    });
    expect(expected).toMatchObject({ basis: 'paid', reason: 'paid', paidCents: 7000 });
    expect(pool?.monthlyRemainingCents).toBe(expected.allowanceCents);
    const ledger = await db.select().from(creditLedger).where(eq(creditLedger.walletId, pool!.id));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].stripeRef).toBe(invoice.id);
    // Paying lifted the lapse through the webhook mirror alone.
    expect((await getOrgStatus(orgId)).status).toBe('active');

    // The org's subscription ends in Stripe: the real deletion event lapses the org, and a replay changes nothing.
    await client.subscriptions.cancel(linkage.stripeSubscriptionId);
    const deleted = await realEvent('customer.subscription.deleted', linkage.stripeCustomerId, since);
    expect(await deliver(deleted)).toBe(200);
    expect((await getOrgStatus(orgId)).status).toBe('lapsed');
    const [afterFirst] = await db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId));
    expect(afterFirst.status).toBe('canceled');
    expect(await deliver(deleted)).toBe(200);
    const [afterReplay] = await db.select().from(orgSubscriptions).where(eq(orgSubscriptions.orgId, orgId));
    expect(afterReplay.updatedAt).toEqual(afterFirst.updatedAt);
    // Lapse touched no credit: the pool still holds exactly the one grant.
    expect((await poolOf(orgId))?.monthlyRemainingCents).toBe(expected.allowanceCents);
  });
});

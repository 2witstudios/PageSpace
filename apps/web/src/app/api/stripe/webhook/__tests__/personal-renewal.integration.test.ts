// @vitest-environment node
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import Stripe from 'stripe';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { Pool } from 'pg';
import { resolve } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { runMigrations } from '../../../../../../../../packages/db/src/migration-runner';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { subscriptions, stripeEvents } from '@pagespace/db/schema/subscriptions';
import { wallets } from '@pagespace/db/schema/wallets';
import { creditLedger } from '@pagespace/db/schema/credits';
import { factories } from '@pagespace/db/test/factories';
import { stripeConfig } from '@/lib/stripe-config';
import { computeCronSignature } from '@/lib/auth/cron-auth';
vi.mock('@/lib/billing/send-payment-receipt-email', () => ({ sendSubscriptionReceiptEmail: vi.fn() }));
import { POST } from '../route';
import { GET as sweep } from '@/app/api/cron/reset-wallet-allocations/route';

// The hourly sweep touches every wallet: give this file a fully migrated database so it cannot
// reset other suites' fixtures when CI runs web files concurrently.
const database = vi.hoisted(() => {
  const sourceUrl = process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/pagespace_test';
  const url = new URL(sourceUrl);
  if (!['localhost', '127.0.0.1', 'postgres', 'db'].includes(url.hostname)) throw new Error('Personal renewal rehearsal requires a local PostgreSQL server');
  const name = `ow_personal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  url.pathname = `/${name}`;
  process.env.DATABASE_URL = url.toString();
  return { sourceUrl, name };
});
let adminPool: Pool;
beforeAll(async () => {
  adminPool = new Pool({ connectionString: database.sourceUrl });
  await adminPool.query(`CREATE DATABASE "${database.name}"`);
  await runMigrations(db, readMigrationFiles({ migrationsFolder: resolve(__dirname, '../../../../../../../../packages/db/drizzle') }), { migrationsSchema: 'drizzle', migrationsTable: '__drizzle_migrations' });
}, 60_000);
afterAll(async () => {
  await pool.end();
  // Background audit clients live until the worker exits. Retain the empty fixture DB
  // for that lifetime; CI's disposable PostgreSQL service owns its final teardown.
  await adminPool.end();
  process.env.DATABASE_URL = database.sourceUrl;
});

const userIds: string[] = [];
const eventIds: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (eventIds.length) await db.delete(stripeEvents).where(inArray(stripeEvents.id, eventIds.splice(0)));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds.splice(0)));
});

it('MONEY-2 reverse-delivered signed paid invoices cannot rewind the period; the actual hourly allocation endpoint renews the child and replays grant nothing', { timeout: 15_000 }, async () => {
  const secret = 'whsec_personal_ordering_local_fixture';
  const cronSecret = 'personal-renewal-cron-secret-at-least-32-characters';
  vi.stubEnv('DEPLOYMENT_MODE', 'cloud');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_signature_only');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', secret);
  vi.stubEnv('CRON_SECRET', cronSecret);
  const client = new Stripe('sk_test_signature_only', { apiVersion: '2026-02-25.clover' });
  const customerId = `cus_${createId()}`;
  const subscriptionId = `sub_${createId()}`;
  const owner = await factories.createUser({ subscriptionTier: 'pro', stripeCustomerId: customerId });
  userIds.push(owner.id);
  const start = new Date('2026-10-01T00:00:00Z');
  const end = new Date('2026-11-01T00:00:00Z');
  await db.insert(subscriptions).values({ userId: owner.id, stripeSubscriptionId: subscriptionId, stripePriceId: stripeConfig.priceIds.pro, status: 'active', currentPeriodStart: start, currentPeriodEnd: end });
  const [root] = await db.insert(wallets).values({ userId: owner.id }).returning();
  const drive = await factories.createDrive(owner.id);
  const [child] = await db.insert(wallets).values({ userId: owner.id, parentWalletId: root.id, subjectType: 'drive', subjectId: drive.id, monthlyAllowanceCents: 150, spentCents: 150, monthlyPeriodStart: start, monthlyPeriodEnd: end }).returning();
  const invoice = (periodStart: Date, periodEnd: Date, paid: number) => ({
    id: `evt_${createId()}`, object: 'event', api_version: '2026-02-25.clover', type: 'invoice.paid', livemode: false,
    data: { object: { id: `in_${createId()}`, object: 'invoice', customer: customerId, currency: 'usd', amount_paid: paid, subtotal: paid, billing_reason: 'subscription_cycle',
      parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
      lines: { has_more: false, data: [{ amount: paid, currency: 'usd', parent: { type: 'subscription_item_details', subscription_item_details: { subscription: subscriptionId, subscription_item: 'si_fixture' } }, period: { start: periodStart.getTime() / 1000, end: periodEnd.getTime() / 1000 }, pricing: { price_details: { price: stripeConfig.priceIds.pro } } }] },
    } },
  });
  const deliver = async (event: ReturnType<typeof invoice>) => {
    eventIds.push(event.id);
    const payload = JSON.stringify(event);
    const signature = client.webhooks.generateTestHeaderString({ payload, secret });
    return POST(new Request('https://pagespace.ai/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': signature }, body: payload }) as import('next/server').NextRequest);
  };
  const current = invoice(start, end, 1500);
  const old = invoice(new Date('2026-09-01T00:00:00Z'), start, 1000);
  expect((await deliver(current)).status).toBe(200);
  expect((await deliver(old)).status).toBe(200);
  const [funded] = await db.select().from(wallets).where(eq(wallets.id, root.id));
  expect(funded.monthlyPeriodStart).toEqual(start);
  expect(funded.monthlyPeriodEnd).toEqual(end);
  expect((await deliver(old)).status).toBe(200);
  expect((await deliver(current)).status).toBe(200);
  expect((await db.select().from(wallets).where(eq(wallets.id, root.id)))[0]).toEqual(funded);
  expect(await db.select().from(creditLedger).where(eq(creditLedger.userId, owner.id))).toHaveLength(2);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(end);
  const path = '/api/cron/reset-wallet-allocations';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = createId();
  const result = await sweep(new Request(`https://pagespace.ai${path}`, { headers: { 'X-Cron-Timestamp': timestamp, 'X-Cron-Nonce': nonce, 'X-Cron-Signature': computeCronSignature(cronSecret, timestamp, nonce, 'GET', path) } }));
  expect(result.status).toBe(200);
  expect((await db.select().from(wallets).where(eq(wallets.id, child.id)))[0]).toMatchObject({ spentCents: 0, monthlyPeriodStart: end });
});

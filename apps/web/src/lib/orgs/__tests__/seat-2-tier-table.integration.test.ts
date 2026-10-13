// @vitest-environment node
/**
 * SEAT-2 end to end: the one tier table (packages/lib/src/billing/subscription-tiers.ts) is Free,
 * Pro and Business; Business is the org plan, never sold to a lone user; buying it is creating an
 * org (create-then-pay: the org row first, then its own customer and one Business subscription,
 * SEAT-9 covering the org that never pays); and every surface states the seat terms FROM the
 * table, so one edit there moves them all. Real Postgres for the org; an in-memory Stripe.
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import type { SessionAuthResult } from '@/lib/auth';

const { stripeCalls } = vi.hoisted(() => ({ stripeCalls: [] as string[] }));
vi.mock('@/lib/auth', () => ({ authenticateRequestWithOptions: vi.fn(), isAuthError: vi.fn((r: object) => 'error' in r) }));
// Any Stripe call from the personal-plan routes is recorded: a lone user's Business purchase must make none.
vi.mock('@/lib/stripe', () => {
  const record = (name: string) => vi.fn(async () => { stripeCalls.push(name); throw new Error(`unexpected Stripe call ${name}`); });
  return {
    stripe: { subscriptions: { create: record('subscriptions.create'), update: record('subscriptions.update'), retrieve: record('subscriptions.retrieve'), list: record('subscriptions.list') }, customers: { create: record('customers.create') } },
    Stripe: class {},
  };
});

import { authenticateRequestWithOptions } from '@/lib/auth';
import { TIERS, TIER_PLAN_LIMITS, isOrgPlanTier, personalTiers } from '@pagespace/lib/billing/subscription-tiers';
import { createOrganization } from '@pagespace/lib/organizations/repository';
import { stripeConfig } from '@/lib/stripe-config';
import { startOrgBusinessSubscription, type OrgBillingDeps } from '@/lib/org-billing/org-subscription';
import { FakeOrgStripe } from '@/lib/org-billing/__tests__/fake-org-stripe';
import { POST as createSubscription } from '@/app/api/stripe/create-subscription/route';
import { POST as updateSubscription } from '@/app/api/stripe/update-subscription/route';

const REPO = path.resolve(__dirname, '../../../../../..');
const orgIds: string[] = [];
const userIds: string[] = [];
let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

const session = (userId: string): SessionAuthResult => ({ userId, tokenVersion: 0, tokenType: 'session', sessionId: 'sess', role: 'user', adminRoleVersion: 0 });
const post = (url: string, body: unknown) =>
  new NextRequest(`https://example.test${url}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

/** Source files of every consumer of the table (apps and lib), tests excluded. */
function consumerSources(): Array<{ file: string; code: string }> {
  const roots = ['apps/web/src', 'apps/marketing/src', 'apps/admin/src', 'apps/control-plane/src', 'apps/e2e', 'packages/lib/src'];
  const out: Array<{ file: string; code: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__tests__' || name === '.next' || name === 'dist') continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
        // Comments may explain the terms; only code and copy must not restate them.
        const code = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
        out.push({ file: path.relative(REPO, full), code });
      }
    }
  };
  for (const root of roots) walk(path.join(REPO, root));
  return out;
}

describe('SEAT-2 the tier table is Free, Pro and Business; Business is the org plan, bought by creating an org and never by a lone user; every surface states its terms from the table', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: orgSubscriptions.id }).from(orgSubscriptions).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('seat-2-tier-table.integration.test.ts', error);
    }
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (!dbAvailable) return;
    if (orgIds.length > 0) {
      await db.delete(orgSubscriptions).where(inArray(orgSubscriptions.orgId, orgIds));
      await db.delete(orgMembers).where(inArray(orgMembers.orgId, orgIds));
      await db.delete(organizations).where(inArray(organizations.id, orgIds));
    }
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
  });

  it('the table is exactly Free, Pro, Business (no Founder); only Business is an org plan, with included seats and an extra-seat price; personal plans are Free and Pro', () => {
    expect([...TIERS]).toEqual(['free', 'pro', 'business']);
    expect(TIERS.filter(isOrgPlanTier)).toEqual(['business']);
    expect(personalTiers()).toEqual(['free', 'pro']);
    const business = TIER_PLAN_LIMITS.business;
    expect(business.includedSeats).toBeGreaterThan(0);
    expect(business.extraSeatUsd).toBeGreaterThan(0);
    expect(business.priceMonthlyUsd).toBeGreaterThan(TIER_PLAN_LIMITS.pro.priceMonthlyUsd);
  });

  it('a lone user can neither buy nor switch to either org price: both personal-plan routes refuse 400 before any Stripe call', async () => {
    if (!dbAvailable) return;
    const lone = await factories.createUser({ subscriptionTier: 'free' });
    userIds.push(lone.id);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(session(lone.id));
    const orgPrices = [stripeConfig.orgPriceIds.businessBase, stripeConfig.orgPriceIds.extraSeat];
    expect(orgPrices.every(Boolean)).toBe(true);
    for (const priceId of orgPrices) {
      const bought = await createSubscription(post('/api/stripe/create-subscription', { priceId }));
      expect(bought.status).toBe(400);
      const switched = await updateSubscription(post('/api/stripe/update-subscription', { priceId }));
      expect(switched.status).toBe(400);
    }
    expect(stripeCalls).toEqual([]);
    const [after] = await db.select({ tier: users.subscriptionTier, customer: users.stripeCustomerId }).from(users).where(eq(users.id, lone.id));
    expect(after).toEqual({ tier: 'free', customer: null });
  });

  it('buying Business is creating an org: the org gets its own customer and exactly one Business subscription (base once, extra seats past the table\'s included count), awaiting its first payment, and the Owner\'s personal plan is untouched', async () => {
    if (!dbAvailable) return;
    process.env.DEPLOYMENT_MODE = 'cloud';
    const owner = await factories.createUser({ subscriptionTier: 'pro' });
    userIds.push(owner.id);
    const created = await createOrganization({ name: 'Northwind Labs', slug: `northwind-${Math.random().toString(36).slice(2, 10)}`, ownerId: owner.id });
    if (!created.ok) throw new Error(`org create failed: ${created.reason}`);
    const orgId = created.organization.id;
    orgIds.push(orgId);
    const seats = TIER_PLAN_LIMITS.business.includedSeats + 2;
    const stripe = new FakeOrgStripe();
    const deps: OrgBillingDeps = {
      stripe,
      prices: () => ({ basePriceId: stripeConfig.orgPriceIds.businessBase, seatPriceId: stripeConfig.orgPriceIds.extraSeat }),
      countSeats: async () => seats,
    };

    const start = await startOrgBusinessSubscription(orgId, deps);
    expect(start.state).toBe('payment_required');
    expect(stripe.customers.size).toBe(1);
    const [customer] = [...stripe.customers.values()];
    expect(stripe.liveSubscriptions(customer.id)).toHaveLength(1);
    const [sub] = [...stripe.subscriptions.values()];
    expect(sub.items.map((i) => [i.priceId, i.quantity])).toEqual([
      [stripeConfig.orgPriceIds.businessBase, 1],
      [stripeConfig.orgPriceIds.extraSeat, 2],
    ]);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    expect(org.stripeCustomerId).toBe(customer.id);
    const [person] = await db.select({ tier: users.subscriptionTier, customer: users.stripeCustomerId }).from(users).where(eq(users.id, owner.id));
    expect(person).toEqual({ tier: 'pro', customer: null });
  });

  it('every surface states the terms the table holds: the plan card, create dialog, first invoice and Plan & seats page read the table\'s seats and prices', async () => {
    const { includedSeats, priceMonthlyUsd, extraSeatUsd } = TIER_PLAN_LIMITS.business;
    const { planFacts } = await import('@pagespace/lib/billing/credit-copy');
    const { orgPlanQuote } = await import('@pagespace/lib/billing/org-plan-quote');
    const { createOrgPlanNote, firstPaymentLines } = await import('../create-org-flow');
    const { planFigures } = await import('../org-billing');

    const card = planFacts('business');
    expect(card.price).toBe(`$${priceMonthlyUsd}`);
    expect(card.org?.seatTerms).toBe(`per organization · ${includedSeats} seats included · $${extraSeatUsd} per extra seat a month`);
    expect(createOrgPlanNote(orgPlanQuote(1)).headline).toBe(`Business · $${priceMonthlyUsd} a month with ${includedSeats} seats, $${extraSeatUsd} per extra seat.`);
    expect(firstPaymentLines(0).lines[0].label).toBe(`Business · ${includedSeats} seats included`);
    const seats = { purchased: includedSeats, held: includedSeats, members: includedSeats, pendingInvites: 0, included: includedSeats, purchasedExtra: 0, autoAdd: false, hasSubscription: true, currentPeriodEnd: null };
    expect(planFigures(seats).terms).toBe(`$${priceMonthlyUsd} a month with ${includedSeats} seats · $${extraSeatUsd} per extra seat`);
  });

  it('one edit to the table moves the org hub: with Business at 7 seats included the Plan & seats row says 7', async () => {
    vi.resetModules();
    vi.doMock('@pagespace/lib/billing/subscription-tiers', async (importOriginal) => {
      const real = await importOriginal<typeof import('@pagespace/lib/billing/subscription-tiers')>();
      return { ...real, TIER_PLAN_LIMITS: { ...real.TIER_PLAN_LIMITS, business: { ...real.TIER_PLAN_LIMITS.business, includedSeats: 7 } } };
    });
    try {
      const { orgHubSections } = await import('../org-hub');
      const hub = orgHubSections({ orgId: 'o1', orgName: 'Northwind Labs', role: 'OWNER', counts: {}, billingEnabled: true });
      const planRow = hub.flatMap((s) => s.rows).find((r) => r.title === 'Plan & seats');
      expect(planRow?.description).toBe('Business plan · 7 seats included, extra seats added as people join');
    } finally {
      vi.doUnmock('@pagespace/lib/billing/subscription-tiers');
      vi.resetModules();
    }
  });

  it('no consumer restates the seat terms: outside the tier table, no app or lib source (web plans, admin, marketing pricing, control-plane bridge, e2e seeds) types the included-seat count or the Business or extra-seat price', () => {
    const { includedSeats, priceMonthlyUsd, extraSeatUsd } = TIER_PLAN_LIMITS.business;
    const restated = new RegExp(
      [
        `\\b${includedSeats} seats\\b`,
        `includedSeats:\\s*${includedSeats}\\b`,
        `\\$${priceMonthlyUsd}(\\.00)?\\s*(/|a |per )\\s*month`,
        `\\$${extraSeatUsd}(\\.00)?\\s*(/month\\s*)?per (extra )?seat`,
      ].join('|'),
    );
    const offenders = consumerSources()
      .filter(({ file }) => file !== 'packages/lib/src/billing/subscription-tiers.ts')
      .filter(({ code }) => restated.test(code))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

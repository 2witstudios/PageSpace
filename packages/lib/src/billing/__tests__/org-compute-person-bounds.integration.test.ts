/**
 * The per-person gate bounds are spend-kind aware (Spec WAL-9) — real Postgres, real gate.
 *
 * Org-paid compute names a person on its rows (the drive lead for an accrual, the session owner
 * for a run) because credit rows must. The daily exposure cap, the in-flight count and the reserved
 * sum bound a PERSON, so before this they counted that person's org compute as their own spend:
 * the lead's unrelated AI could refuse an org app's wake, and org accruals ate the lead's own AI
 * headroom. The bounds now count in one of two scopes (person-bound-scope.ts): the org pool's
 * compute gate counts only org-paid compute, every other gate counts everything EXCEPT it.
 *
 * Both directions are asserted, and so is the half that must NOT change: a person's AI, and their
 * own personal-wallet compute, still count against their AI cap exactly as before, and the org
 * compute of one person is still bounded by that person's own org compute.
 *
 * Requires DATABASE_URL → a migrated Postgres (requireDb fails loudly without one).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { creditHolds, creditLedger, type SpendKind } from '@pagespace/db/schema/credits';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { walletConsumerCaps, wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { canConsumeAI } from '../credit-gate';
import { gateComputeCharge } from '../compute-gate';
import { PERSONAL_SPEND } from '../spend-target';
import type { ComputeCharge } from '../compute-charge';

const originalMode = process.env.DEPLOYMENT_MODE;
let dbAvailable = false;

/** What the published-app meter passes: a 20-dollar per-person daily ceiling (PUBLISHED_APP_DAILY_CAP_CEILING_CENTS). */
const CEILING_CENTS = 2000;
/** 21 dollars in millicents: over the ceiling on its own. */
const OVER_MC = 2_100_000;
const HOLD_EST = 50;

interface World {
  orgId: string;
  leadId: string;
  orgCharge: ComputeCharge;
  poolId: string;
  leadWalletId: string;
  userIds: string[];
}

let world: World | null = null;

async function build(): Promise<World> {
  const lead = await factories.createUser({ name: 'Jono (lead)', subscriptionTier: 'pro' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: lead.id }).returning();
  // Paid: there is no org trial, and an unpaid org is lapsed from creation (D-OW-30).
  await factories.createOrgSubscription(org.id);
  await db.insert(orgMembers).values({ orgId: org.id, userId: lead.id, role: 'OWNER' });
  const [pool] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 100_000 }).returning();
  const [leadWallet] = await db.insert(wallets).values({
    userId: lead.id,
    monthlyRemainingCents: 100_000,
    monthlyAllowanceCents: 100_000,
    monthlyPeriodStart: new Date(),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  return { orgId: org.id, leadId: lead.id, orgCharge: { kind: 'org', orgId: org.id, userId: lead.id }, poolId: pool.id, leadWalletId: leadWallet.id, userIds: [lead.id] };
}

async function teardown(w: World): Promise<void> {
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  await db.delete(walletConsumerCaps).where(eq(walletConsumerCaps.walletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

/** A settled usage row today, recorded under the lead, on `walletId`, of `spendKind`. */
async function spendToday(w: World, input: { walletId: string; spendKind: SpendKind; mc: number }): Promise<void> {
  await db.insert(creditLedger).values({
    userId: w.leadId,
    walletId: input.walletId,
    entryType: 'usage',
    bucket: 'monthly',
    amountCents: -Math.round(input.mc / 1000),
    appliedCents: Math.round(input.mc / 1000),
    chargeMillicents: input.mc,
    consumeStatus: 'applied',
    spendKind: input.spendKind,
  });
}

async function holdNow(w: World, input: { walletId: string; spendKind: SpendKind }): Promise<void> {
  await db.insert(creditHolds).values({ userId: w.leadId, walletId: input.walletId, estCents: HOLD_EST, expiresAt: new Date(Date.now() + 600_000), spendKind: input.spendKind });
}

const orgGate = (w: World, maxInFlight?: number) => gateComputeCharge(w.orgCharge, { estCostCents: HOLD_EST, dailyCapCeilingCents: CEILING_CENTS, maxInFlight });
const aiGate = (w: World, maxInFlight?: number) => canConsumeAI(w.leadId, 'pro', { estCostCents: HOLD_EST, dailyCapCeilingCents: CEILING_CENTS, maxInFlight, spend: PERSONAL_SPEND });

beforeAll(async () => {
  try {
    await db.select({ id: wallets.id }).from(wallets).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('org-compute-person-bounds.integration.test.ts', error);
  }
});

beforeEach(() => {
  process.env.DEPLOYMENT_MODE = 'cloud';
});

afterEach(async () => {
  process.env.DEPLOYMENT_MODE = originalMode;
  if (dbAvailable && world) await teardown(world);
  world = null;
});

describe('the daily exposure cap', () => {
  it("WAL-9 (partial) the lead's unrelated AI spend does not refuse an org app's wake: org compute is bounded by org compute, not by AI", async () => {
    const w = (world = await build());
    await spendToday(w, { walletId: w.leadWalletId, spendKind: 'ai', mc: OVER_MC });

    const org = await orgGate(w);

    expect(org).toMatchObject({ allowed: true });
    expect(org.allowed && org.walletId).toBe(w.poolId);
  });

  it("WAL-9 (partial) a person's org compute does not eat their own AI headroom", async () => {
    const w = (world = await build());
    await spendToday(w, { walletId: w.poolId, spendKind: 'compute', mc: OVER_MC });

    expect(await aiGate(w)).toMatchObject({ allowed: true });
  });

  it("WAL-9 (partial) the org compute bound still binds that person's own org compute: over the ceiling on the pool refuses the next org run", async () => {
    const w = (world = await build());
    // A monthly allowance far above the spend, so the per-member pool cap (WAL-2, which person-run
    // compute now counts toward) has room and only the daily exposure bound can refuse.
    await db.insert(walletConsumerCaps).values({ walletId: w.poolId, consumerKey: `user:${w.leadId}`, monthlyCapCents: 10 * OVER_MC });
    await spendToday(w, { walletId: w.poolId, spendKind: 'compute', mc: OVER_MC });

    expect(await orgGate(w)).toMatchObject({ allowed: false, reason: 'daily_cap_exceeded' });
  });

  it("the per-person AI cap still bites exactly as before: over the ceiling in AI refuses the next AI call", async () => {
    const w = (world = await build());
    await spendToday(w, { walletId: w.leadWalletId, spendKind: 'ai', mc: OVER_MC });

    expect(await aiGate(w)).toMatchObject({ allowed: false, reason: 'daily_cap_exceeded' });
  });

  it("a person's OWN compute on their personal wallet still counts toward their cap, as before: only ORG-paid compute left the person's bounds", async () => {
    const w = (world = await build());
    await spendToday(w, { walletId: w.leadWalletId, spendKind: 'compute', mc: OVER_MC });

    expect(await aiGate(w)).toMatchObject({ allowed: false, reason: 'daily_cap_exceeded' });
  });
});

describe('the in-flight and reserved bounds', () => {
  it("WAL-9 (partial) the lead's in-flight AI calls do not count against an org run's in-flight ceiling", async () => {
    const w = (world = await build());
    await holdNow(w, { walletId: w.leadWalletId, spendKind: 'ai' });
    await holdNow(w, { walletId: w.leadWalletId, spendKind: 'ai' });

    expect(await orgGate(w, 1)).toMatchObject({ allowed: true });
  });

  it("WAL-9 (partial) an org run in flight does not count against the lead's AI in-flight ceiling", async () => {
    const w = (world = await build());
    await holdNow(w, { walletId: w.poolId, spendKind: 'compute' });

    expect(await aiGate(w, 1)).toMatchObject({ allowed: true });
  });

  it("the org in-flight bound still binds a person's org runs: a second run while one is held on the pool is refused at ceiling 1", async () => {
    const w = (world = await build());
    await holdNow(w, { walletId: w.poolId, spendKind: 'compute' });

    expect(await orgGate(w, 1)).toMatchObject({ allowed: false, reason: 'concurrency_limit', orgRefusal: 'concurrency_limit' });
  });

  it("the AI in-flight bound still binds exactly as before: a second AI call while one is held is refused at ceiling 1", async () => {
    const w = (world = await build());
    await holdNow(w, { walletId: w.leadWalletId, spendKind: 'ai' });

    expect(await aiGate(w, 1)).toMatchObject({ allowed: false, reason: 'too_many_in_flight' });
  });

  it("a person's own personal-wallet compute hold still counts in their in-flight bound, as before", async () => {
    const w = (world = await build());
    await holdNow(w, { walletId: w.leadWalletId, spendKind: 'compute' });

    expect(await aiGate(w, 1)).toMatchObject({ allowed: false, reason: 'too_many_in_flight' });
  });
});

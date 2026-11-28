/**
 * Owner pays (ADR 0008 Decision 8, §5 assertion 14; Agent Signup Phase 4) —
 * against a REAL Postgres, the real gate, settle and release.
 *
 * A claimed agent's own-credits spend reserves on, and settles against, its
 * OWNER's personal root wallet at the owner's tier: the owner's wallet ledger
 * carries the charge, the hold names the owner's wallet, and the agent's own
 * wallet row is never touched. An unclaimed agent and a revoked one never
 * reach anyone else's wallet.
 *
 * The seam is `resolveOwnCreditsPayer` (agent-billing-owner.ts), whose
 * decision is the frozen `resolveBillingPayer`. Mutation check: make
 * `resolveBillingPayer` always answer the caller — every "owner" case here
 * goes red.
 *
 * Excluded from the unit run (vitest.config.ts); CI's lib integration step
 * picks it up by glob.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { wallets, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { agentIdentities } from '@pagespace/db/schema/agent-identities';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { canConsumeAI, resolveEntitlementTier } from '../credit-gate';
import { consumeCredits, releaseHold } from '../credit-consume';
import { PERSONAL_SPEND } from '../spend-target';
import { listSpendChoices } from '../spend-resolution';
import { getOwnCreditsBalance } from '../own-credits-balance';
import { getCreditBalance } from '../credit-balance';

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;
let createdUserIds: string[] = [];

beforeAll(async () => {
  try {
    await db.select({ id: wallets.id }).from(wallets).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('agent-owner-pays.integration.test.ts', error);
    dbAvailable = false;
  }
});

beforeEach(() => {
  process.env.DEPLOYMENT_MODE = 'cloud';
});

afterEach(async () => {
  if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
  else process.env.DEPLOYMENT_MODE = originalMode;
  if (!dbAvailable || createdUserIds.length === 0) return;
  const ownedWallets = await db.select({ id: wallets.id }).from(wallets).where(inArray(wallets.userId, createdUserIds));
  const walletIds = ownedWallets.map((w) => w.id);
  await db.delete(creditHolds).where(inArray(creditHolds.userId, createdUserIds));
  if (walletIds.length > 0) {
    await db.delete(creditHolds).where(inArray(creditHolds.walletId, walletIds));
    await db.delete(creditLedger).where(inArray(creditLedger.walletId, walletIds));
  }
  await db.delete(creditLedger).where(inArray(creditLedger.userId, createdUserIds));
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, createdUserIds));
  if (walletIds.length > 0) await db.delete(wallets).where(inArray(wallets.id, walletIds));
  await db.delete(users).where(inArray(users.id, createdUserIds));
  createdUserIds = [];
});

const OWNER_TOPUP_CENTS = 1_000;

async function seedOwner(tier: 'free' | 'pro' = 'pro') {
  const owner = await factories.createUser({ accountType: 'human', subscriptionTier: tier });
  createdUserIds.push(owner.id);
  // A funded personal root wallet with a period stamped, so the gate neither lazily inits
  // nor grants: the only movement on it is this test's spend.
  const now = new Date();
  const [wallet] = await db.insert(wallets).values({
    ownerType: 'user',
    userId: owner.id,
    monthlyRemainingCents: 0,
    monthlyAllowanceCents: 0,
    topupRemainingCents: OWNER_TOPUP_CENTS,
    debtCents: 0,
    pendingMillicents: 0,
    monthlyPeriodStart: now,
    monthlyPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
  }).returning({ id: wallets.id });
  return { ownerId: owner.id, ownerWalletId: wallet.id };
}

async function seedAgent(ownerUserId: string | null, opts: { revoked?: boolean } = {}) {
  const agent = await factories.createUser({ accountType: 'agent', subscriptionTier: 'free' });
  createdUserIds.push(agent.id);
  await db.insert(agentIdentities).values({
    userId: agent.id,
    secretHash: `test-hash-${agent.id}`,
    secretPrefix: 'ps_agent_tst',
    ownerUserId,
    claimedAt: ownerUserId ? new Date() : null,
    revokedAt: opts.revoked ? new Date() : null,
  });
  return agent.id;
}

/** The agent's OWN personal root wallet, which a claimed agent's spend must never touch. */
async function seedAgentBareWallet(agentId: string) {
  await db.insert(wallets).values({
    ownerType: 'user',
    userId: agentId,
    monthlyRemainingCents: 0,
    monthlyAllowanceCents: 0,
    topupRemainingCents: 0,
    debtCents: 0,
    pendingMillicents: 0,
  });
}

async function walletOf(userId: string) {
  const [row] = await db
    .select({ id: wallets.id, topup: wallets.topupRemainingCents, monthly: wallets.monthlyRemainingCents, debt: wallets.debtCents, pending: wallets.pendingMillicents })
    .from(wallets)
    .where(personalRootWalletOf(userId))
    .limit(1);
  return row ?? null;
}

describe('owner pays — a claimed agent spends its owner\'s own credits (real Postgres)', () => {
  it("reserves on the OWNER's wallet at the owner's tier, settles there, and never touches the agent's own wallet", async () => {
    if (!dbAvailable) return;
    const { ownerId, ownerWalletId } = await seedOwner('pro');
    const agentId = await seedAgent(ownerId);
    await seedAgentBareWallet(agentId);
    const agentWalletBefore = await walletOf(agentId);

    const gate = await canConsumeAI(agentId, 'free', { spend: PERSONAL_SPEND });

    expect(gate).toMatchObject({ allowed: true, walletId: ownerWalletId, spendSource: 'own_credits', entitlementTier: 'pro' });
    const [hold] = await db.select({ userId: creditHolds.userId, walletId: creditHolds.walletId }).from(creditHolds).where(eq(creditHolds.id, gate.holdId ?? ''));
    // The agent is the consumer; the owner's wallet is what it reserves against.
    expect(hold).toEqual({ userId: agentId, walletId: ownerWalletId });

    const [log] = await db.insert(aiUsageLogs).values({ userId: agentId, provider: 'openrouter', model: 'm', cost: 0.5 }).returning({ id: aiUsageLogs.id });
    expect(await consumeCredits({ aiUsageLogId: log.id, userId: agentId, costDollars: 0.5, holdId: gate.holdId, walletId: gate.walletId })).toBe('settled');

    // The owner's wallet ledger shows the charge…
    const charges = await db
      .select({ walletId: creditLedger.walletId, entryType: creditLedger.entryType, consumeStatus: creditLedger.consumeStatus, chargeMillicents: creditLedger.chargeMillicents })
      .from(creditLedger)
      .where(eq(creditLedger.aiUsageLogId, log.id));
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ walletId: ownerWalletId, entryType: 'usage', consumeStatus: 'applied' });
    expect(charges[0].chargeMillicents ?? 0).toBeGreaterThan(0);
    const ownerAfter = await walletOf(ownerId);
    expect(ownerAfter?.topup).toBeLessThan(OWNER_TOPUP_CENTS);

    // …and the agent's own wallet row is exactly as it was; no ledger row names it.
    expect(await walletOf(agentId)).toEqual(agentWalletBefore);
    const onAgentWallet = await db.select({ id: creditLedger.id }).from(creditLedger).where(eq(creditLedger.walletId, agentWalletBefore?.id ?? ''));
    expect(onAgentWallet).toEqual([]);
    // The hold was settled.
    expect(await db.select({ id: creditHolds.id }).from(creditHolds).where(eq(creditHolds.id, gate.holdId ?? ''))).toEqual([]);
  });

  it("releases a hold placed on the owner's wallet without charging anyone", async () => {
    if (!dbAvailable) return;
    const { ownerId, ownerWalletId } = await seedOwner('pro');
    const agentId = await seedAgent(ownerId);
    const before = await walletOf(ownerId);

    const gate = await canConsumeAI(agentId, 'free', { spend: PERSONAL_SPEND });
    expect(gate).toMatchObject({ allowed: true, walletId: ownerWalletId });
    await releaseHold(gate.holdId ?? '');

    expect(await db.select({ id: creditHolds.id }).from(creditHolds).where(eq(creditHolds.id, gate.holdId ?? ''))).toEqual([]);
    expect(await walletOf(ownerId)).toEqual(before);
    // No own wallet was ever created for the agent.
    expect(await walletOf(agentId)).toBeNull();
  });

  it("uses the owner's tier for the pro-model entitlement of a personal call", async () => {
    if (!dbAvailable) return;
    const { ownerId } = await seedOwner('pro');
    const agentId = await seedAgent(ownerId);
    expect(await resolveEntitlementTier(agentId, 'free', PERSONAL_SPEND)).toBe('pro');
  });

  it('given an UNCLAIMED agent, should refuse with requires_funding and reach no other wallet', async () => {
    if (!dbAvailable) return;
    const { ownerId } = await seedOwner('pro');
    const before = await walletOf(ownerId);
    const agentId = await seedAgent(null);

    expect(await canConsumeAI(agentId, 'free', { spend: PERSONAL_SPEND })).toMatchObject({ allowed: false, reason: 'requires_funding' });
    expect(await walletOf(ownerId)).toEqual(before);
    const holds = await db.select({ id: creditHolds.id }).from(creditHolds).where(and(eq(creditHolds.userId, agentId)));
    expect(holds).toEqual([]);
  });

  it("given a REVOKED agent that still names an owner, should never reach the owner's wallet", async () => {
    if (!dbAvailable) return;
    const { ownerId, ownerWalletId } = await seedOwner('pro');
    const before = await walletOf(ownerId);
    const agentId = await seedAgent(ownerId, { revoked: true });

    const gate = await canConsumeAI(agentId, 'free', { spend: PERSONAL_SPEND });

    expect(gate.allowed).toBe(false);
    expect(gate.walletId).not.toBe(ownerWalletId);
    expect(await walletOf(ownerId)).toEqual(before);
  });

  it('given a human, should spend their own wallet exactly as before (control)', async () => {
    if (!dbAvailable) return;
    const { ownerId, ownerWalletId } = await seedOwner('pro');
    const gate = await canConsumeAI(ownerId, 'pro', { spend: PERSONAL_SPEND });
    expect(gate).toMatchObject({ allowed: true, walletId: ownerWalletId });
    await releaseHold(gate.holdId ?? '');
  });
});

describe("owner pays — what a claimed agent is SHOWN is its owner's own credits (real Postgres)", () => {
  it("lists own credits as the OWNER's wallet, with the owner's remaining credits, labelled as billed to the owner", async () => {
    if (!dbAvailable) return;
    const { ownerId, ownerWalletId } = await seedOwner();
    await db.update(users).set({ name: 'Dana Owner' }).where(eq(users.id, ownerId));
    const agentId = await seedAgent(ownerId);
    await seedAgentBareWallet(agentId);

    const [own] = await listSpendChoices(agentId, null);
    expect(own).toMatchObject({ source: 'own_credits', walletId: ownerWalletId, remainingCents: OWNER_TOPUP_CENTS, label: 'Billed to Dana Owner' });
  });

  it("shows a claimed agent its owner's balance and names the owner; an unclaimed agent sees its own empty wallet", async () => {
    if (!dbAvailable) return;
    const { ownerId } = await seedOwner();
    await db.update(users).set({ name: 'Dana Owner' }).where(eq(users.id, ownerId));
    const claimed = await seedAgent(ownerId);
    await seedAgentBareWallet(claimed);
    const unclaimed = await seedAgent(null);
    await seedAgentBareWallet(unclaimed);

    const claimedBalance = await getOwnCreditsBalance(claimed, 'free');
    // Exactly what the owner sees of their own wallet (same read, same tier), plus whom it bills.
    expect(claimedBalance).toEqual({ ...(await getCreditBalance(ownerId, 'pro')), subscriptionTier: 'pro', billedTo: { userId: ownerId, name: 'Dana Owner' } });
    expect(claimedBalance.spendable).toBeGreaterThanOrEqual(OWNER_TOPUP_CENTS);

    const unclaimedBalance = await getOwnCreditsBalance(unclaimed, 'free');
    expect(unclaimedBalance.spendable).toBe(0);
    expect(unclaimedBalance.billedTo).toBeNull();
    const [own] = await listSpendChoices(unclaimed, null);
    expect(own).toMatchObject({ source: 'own_credits', remainingCents: 0, label: 'Your credits' });
  });
});

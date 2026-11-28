/**
 * Agent Signup Phase 1 leaf 4 — no starter grant for agents, against a REAL
 * Postgres (ADR 0008 Decision 9, §5 assertion 12; threat model T10).
 *
 * `starterGrantCents` is pure and unit tested; what only the real gate can show
 * is that BOTH lazy-init branches use it — the no-row branch (first AI call)
 * and the bare-row branch (a top-up created the balance row before the first
 * call) — so the exclusion cannot be bypassed by the order a top-up and a first
 * call happen in. Each branch is checked separately for an agent AND a human,
 * so flipping the predicate turns both agent tests red.
 *
 * Excluded from the unit run (vitest.config.ts); CI's lib integration step
 * picks it up by glob.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { wallets, personalRootWalletOf } from '@pagespace/db/schema/wallets';
import { agentIdentities } from '@pagespace/db/schema/agent-identities';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { canConsumeAI } from '../credit-gate';
import { PERSONAL_SPEND } from '../spend-target';
import { tierAllowanceCents } from '../money-model';

/** The free starter grant (MON-8), from the one definition. */
const FREE_STARTER_CENTS = tierAllowanceCents('free');

let dbAvailable = false;
const createdUserIds: string[] = [];

beforeAll(async () => {
  try {
    await db.select().from(wallets).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('agent-starter-grant.integration.test.ts', error);
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (createdUserIds.length === 0) return;
  await db.delete(creditHolds).where(inArray(creditHolds.userId, createdUserIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, createdUserIds));
  await db.delete(wallets).where(inArray(wallets.userId, createdUserIds));
  await db.delete(users).where(inArray(users.id, createdUserIds));
});

async function seedUser(accountType: 'human' | 'agent', ownerUserId: string | null = null) {
  const user = await factories.createUser({ accountType, subscriptionTier: 'free' });
  createdUserIds.push(user.id);
  if (accountType === 'agent') {
    await db.insert(agentIdentities).values({
      userId: user.id,
      secretHash: `test-hash-${user.id}`,
      secretPrefix: 'ps_agent_tst',
      ownerUserId,
      claimedAt: ownerUserId ? new Date() : null,
    });
  }
  return user;
}

/** A top-up that landed before the first AI call: a bare personal root wallet, no period stamped. */
async function seedBareRow(userId: string, topupCents: number) {
  await db.insert(wallets).values({
    ownerType: 'user',
    userId,
    monthlyRemainingCents: 0,
    monthlyAllowanceCents: 0,
    topupRemainingCents: topupCents,
    debtCents: 0,
    pendingMillicents: 0,
  });
}

async function starterGrantRows(userId: string) {
  return db.select().from(creditLedger).where(eq(creditLedger.stripeRef, `free-init-${userId}`));
}

async function balance(userId: string) {
  const [row] = await db.select().from(wallets).where(personalRootWalletOf(userId));
  return row;
}

describe('canConsumeAI — no-row lazy-init branch', () => {
  it('given an unclaimed agent\'s first call, should create a zero-allowance personal root wallet, write NO free-init ledger row, and refuse with requires_funding', async () => {
    if (!dbAvailable) return;
    const agent = await seedUser('agent');

    const result = await canConsumeAI(agent.id, 'free', { spend: PERSONAL_SPEND });

    expect(result).toMatchObject({ allowed: false, reason: 'requires_funding' });
    const row = await balance(agent.id);
    expect(row?.monthlyRemainingCents).toBe(0);
    expect(row?.monthlyAllowanceCents).toBe(0);
    expect(row?.monthlyPeriodEnd).toBeInstanceOf(Date);
    expect(await starterGrantRows(agent.id)).toHaveLength(0);
  });

  it('given a human\'s first call on the same path, should still grant the free starter credits', async () => {
    if (!dbAvailable) return;
    const human = await seedUser('human');

    const result = await canConsumeAI(human.id, 'free', { spend: PERSONAL_SPEND });

    expect(result.allowed).toBe(true);
    const row = await balance(human.id);
    expect(row?.monthlyAllowanceCents).toBe(FREE_STARTER_CENTS);
    const grants = await starterGrantRows(human.id);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.amountCents).toBe(FREE_STARTER_CENTS);
  });
});

describe('canConsumeAI — bare-row starter-grant branch', () => {
  it('given an agent whose balance row was created bare, should write NO free-init row and not fund the monthly bucket', async () => {
    if (!dbAvailable) return;
    const agent = await seedUser('agent');
    await seedBareRow(agent.id, 0);

    const result = await canConsumeAI(agent.id, 'free', { spend: PERSONAL_SPEND });

    expect(result).toMatchObject({ allowed: false, reason: 'requires_funding' });
    expect(await starterGrantRows(agent.id)).toHaveLength(0);
    expect((await balance(agent.id))?.monthlyRemainingCents).toBe(0);
  });

  it('given a human whose balance row was created bare, should still grant the free starter credits once', async () => {
    if (!dbAvailable) return;
    const human = await seedUser('human');
    await seedBareRow(human.id, 0);

    const result = await canConsumeAI(human.id, 'free', { spend: PERSONAL_SPEND });

    expect(result.allowed).toBe(true);
    expect(await starterGrantRows(human.id)).toHaveLength(1);
    expect((await balance(human.id))?.monthlyRemainingCents).toBe(FREE_STARTER_CENTS);
  });
});

describe('canConsumeAI — billing-off deployment (DEPLOYMENT_MODE=tenant)', () => {
  const originalMode = process.env.DEPLOYMENT_MODE;
  afterEach(() => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
  });

  it('given an unclaimed agent in tenant mode, should refuse with requires_funding and create no wallet', async () => {
    if (!dbAvailable) return;
    const agent = await seedUser('agent');
    process.env.DEPLOYMENT_MODE = 'tenant';

    const result = await canConsumeAI(agent.id, 'free', { spend: PERSONAL_SPEND });

    expect(result).toEqual({ allowed: false, reason: 'requires_funding' });
    expect(await balance(agent.id)).toBeUndefined();
  });

  it('given a claimed agent in tenant mode, should be unlimited like its owner', async () => {
    if (!dbAvailable) return;
    const owner = await seedUser('human');
    const agent = await seedUser('agent', owner.id);
    process.env.DEPLOYMENT_MODE = 'tenant';

    expect(await canConsumeAI(agent.id, 'free', { spend: PERSONAL_SPEND })).toEqual({ allowed: true, reason: 'unlimited' });
  });

  it('given a human in tenant mode, should stay unlimited', async () => {
    if (!dbAvailable) return;
    const human = await seedUser('human');
    process.env.DEPLOYMENT_MODE = 'tenant';

    expect(await canConsumeAI(human.id, 'free', { spend: PERSONAL_SPEND })).toEqual({ allowed: true, reason: 'unlimited' });
  });
});

describe('canConsumeAI — refined denial reason', () => {
  it("given a CLAIMED agent with no balance of its own, should spend its OWNER's credits (Phase 4 owner pays) — never an agent starter grant", async () => {
    if (!dbAvailable) return;
    const owner = await seedUser('human');
    const agent = await seedUser('agent', owner.id);

    const result = await canConsumeAI(agent.id, 'free', { spend: PERSONAL_SPEND });

    // The owner's first own-credits call lazily seeds the OWNER's wallet with the
    // human starter grant; the hold names that wallet.
    const [ownerWallet] = await db.select({ id: wallets.id }).from(wallets).where(personalRootWalletOf(owner.id));
    expect(result).toMatchObject({ allowed: true, walletId: ownerWallet?.id });
    expect(await starterGrantRows(owner.id)).toHaveLength(1);
    expect(await starterGrantRows(agent.id)).toHaveLength(0);
    if (result.holdId) await db.delete(creditHolds).where(eq(creditHolds.id, result.holdId));
  });

  it('given a CLAIMED agent whose OWNER is out of credits, should deny with the ordinary out_of_credits (its funding path is its owner, not requires_funding)', async () => {
    if (!dbAvailable) return;
    const owner = await seedUser('human');
    const agent = await seedUser('agent', owner.id);
    // An owner wallet with nothing left and a period stamped: no starter grant applies.
    const now = new Date();
    await db.insert(wallets).values({
      ownerType: 'user',
      userId: owner.id,
      monthlyRemainingCents: 0,
      monthlyAllowanceCents: 0,
      topupRemainingCents: 0,
      debtCents: 0,
      pendingMillicents: 0,
      monthlyPeriodStart: now,
      monthlyPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    });

    const result = await canConsumeAI(agent.id, 'free', { spend: PERSONAL_SPEND });

    expect(result).toMatchObject({ allowed: false, reason: 'out_of_credits' });
    expect(await starterGrantRows(agent.id)).toHaveLength(0);
  });

  it('given a funded agent (a top-up above the floor), should allow — the exclusion is the grant, not the agent', async () => {
    if (!dbAvailable) return;
    const agent = await seedUser('agent');
    await seedBareRow(agent.id, 1000);

    const result = await canConsumeAI(agent.id, 'free', { spend: PERSONAL_SPEND });

    expect(result.allowed).toBe(true);
    expect(await starterGrantRows(agent.id)).toHaveLength(0);
  });
});

describe('rollDuePersonalRoots — the hourly comped-root sweep', () => {
  it('given an agent on a paid tier whose root period has ended, should never grant it a monthly allowance', async () => {
    if (!dbAvailable) return;
    const { rollDuePersonalRoots } = await import('../wallet-funding-shell');
    const agent = await seedUser('agent');
    const human = await seedUser('human');
    await db.update(users).set({ subscriptionTier: 'pro' }).where(inArray(users.id, [agent.id, human.id]));
    const ended = new Date(Date.now() - 1000);
    for (const id of [agent.id, human.id]) {
      await seedBareRow(id, 0);
      await db
        .update(wallets)
        .set({ monthlyPeriodStart: new Date(ended.getTime() - 30 * 24 * 3600 * 1000), monthlyPeriodEnd: ended })
        .where(personalRootWalletOf(id));
    }

    await rollDuePersonalRoots({ now: new Date() });

    const grants = async (userId: string) =>
      (await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))).filter((r) => r.entryType === 'monthly_grant');
    expect(await grants(agent.id)).toHaveLength(0);
    // Control: the same comped state on a human IS rolled, so the agent assertion is not vacuous.
    expect(await grants(human.id)).toHaveLength(1);
  });
});

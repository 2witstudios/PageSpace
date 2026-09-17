/**
 * Agent Signup Phase 1 leaf 4 — no starter grant for agents, against a REAL
 * Postgres (ADR 0007 Decision 9, §5 assertion 12; threat model T10).
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
import { creditBalances, creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { agentIdentities } from '@pagespace/db/schema/agent-identities';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { canConsumeAI } from '../credit-gate';
import { TIER_MONTHLY_ALLOWANCE_CENTS } from '../credit-pricing';

let dbAvailable = false;
const createdUserIds: string[] = [];

beforeAll(async () => {
  try {
    await db.select().from(creditBalances).limit(1);
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
  await db.delete(creditBalances).where(inArray(creditBalances.userId, createdUserIds));
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

/** A top-up that landed before the first AI call: a bare row, no period stamped. */
async function seedBareRow(userId: string, topupCents: number) {
  await db.insert(creditBalances).values({
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
  const [row] = await db.select().from(creditBalances).where(eq(creditBalances.userId, userId));
  return row;
}

describe('canConsumeAI — no-row lazy-init branch', () => {
  it('given an unclaimed agent\'s first call, should create a zero-allowance balance row, write NO free-init ledger row, and refuse with requires_funding', async () => {
    if (!dbAvailable) return;
    const agent = await seedUser('agent');

    const result = await canConsumeAI(agent.id, 'free');

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

    const result = await canConsumeAI(human.id, 'free');

    expect(result.allowed).toBe(true);
    const row = await balance(human.id);
    expect(row?.monthlyAllowanceCents).toBe(TIER_MONTHLY_ALLOWANCE_CENTS.free);
    const grants = await starterGrantRows(human.id);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.amountCents).toBe(TIER_MONTHLY_ALLOWANCE_CENTS.free);
  });
});

describe('canConsumeAI — bare-row starter-grant branch', () => {
  it('given an agent whose balance row was created bare, should write NO free-init row and not fund the monthly bucket', async () => {
    if (!dbAvailable) return;
    const agent = await seedUser('agent');
    await seedBareRow(agent.id, 0);

    const result = await canConsumeAI(agent.id, 'free');

    expect(result).toMatchObject({ allowed: false, reason: 'requires_funding' });
    expect(await starterGrantRows(agent.id)).toHaveLength(0);
    expect((await balance(agent.id))?.monthlyRemainingCents).toBe(0);
  });

  it('given a human whose balance row was created bare, should still grant the free starter credits once', async () => {
    if (!dbAvailable) return;
    const human = await seedUser('human');
    await seedBareRow(human.id, 0);

    const result = await canConsumeAI(human.id, 'free');

    expect(result.allowed).toBe(true);
    expect(await starterGrantRows(human.id)).toHaveLength(1);
    expect((await balance(human.id))?.monthlyRemainingCents).toBe(TIER_MONTHLY_ALLOWANCE_CENTS.free);
  });
});

describe('canConsumeAI — billing-off deployment (DEPLOYMENT_MODE=tenant)', () => {
  const originalMode = process.env.DEPLOYMENT_MODE;
  afterEach(() => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
  });

  it('given an unclaimed agent in tenant mode, should refuse with requires_funding and create no balance row', async () => {
    if (!dbAvailable) return;
    const agent = await seedUser('agent');
    process.env.DEPLOYMENT_MODE = 'tenant';

    const result = await canConsumeAI(agent.id, 'free');

    expect(result).toEqual({ allowed: false, reason: 'requires_funding' });
    expect(await balance(agent.id)).toBeUndefined();
  });

  it('given a claimed agent in tenant mode, should be unlimited like its owner', async () => {
    if (!dbAvailable) return;
    const owner = await seedUser('human');
    const agent = await seedUser('agent', owner.id);
    process.env.DEPLOYMENT_MODE = 'tenant';

    expect(await canConsumeAI(agent.id, 'free')).toEqual({ allowed: true, reason: 'unlimited' });
  });

  it('given a human in tenant mode, should stay unlimited', async () => {
    if (!dbAvailable) return;
    const human = await seedUser('human');
    process.env.DEPLOYMENT_MODE = 'tenant';

    expect(await canConsumeAI(human.id, 'free')).toEqual({ allowed: true, reason: 'unlimited' });
  });
});

describe('canConsumeAI — refined denial reason', () => {
  it('given a CLAIMED agent with no balance, should deny with the ordinary out_of_credits (its funding path is its owner)', async () => {
    if (!dbAvailable) return;
    const owner = await seedUser('human');
    const agent = await seedUser('agent', owner.id);

    const result = await canConsumeAI(agent.id, 'free');

    expect(result).toMatchObject({ allowed: false, reason: 'out_of_credits' });
    expect(await starterGrantRows(agent.id)).toHaveLength(0);
  });

  it('given a funded agent (a top-up above the floor), should allow — the exclusion is the grant, not the agent', async () => {
    if (!dbAvailable) return;
    const agent = await seedUser('agent');
    await seedBareRow(agent.id, 1000);

    const result = await canConsumeAI(agent.id, 'free');

    expect(result.allowed).toBe(true);
    expect(await starterGrantRows(agent.id)).toHaveLength(0);
  });
});

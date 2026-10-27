/**
 * MON-7 credit liability against a real Postgres: the admin figure reads org pools as
 * well as personal roots, and never counts a pool's allocation to a drive wallet twice.
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 * Every read is scoped to the wallets this file seeds, so rows other suites leave in a
 * shared database cannot move the numbers. Deletes every row it creates in dependency
 * order — ledger, legs (cascade), child wallet, pool, roots, members, drives, org, users
 * last — and the integration teardown ends the pool.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray, and, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { driveMembers } from '@pagespace/db/schema/members';
import { organizations } from '@pagespace/db/schema/organizations';
import { creditLedger } from '@pagespace/db/schema/credits';
import { wallets, walletFundingLegs, isPersonalRootWallet } from '@pagespace/db/schema/wallets';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { readCreditLiability } from '../credit-liability-query';
import { donateToDriveWallet } from '../wallet-funding-shell';
import { consumeCredits } from '../credit-consume';

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;
const created = { users: [] as string[], drives: [] as string[], orgs: [] as string[], childWallets: [] as string[], rootWallets: [] as string[], usageLogIds: [] as string[] };

async function user(tier: 'free' | 'pro'): Promise<string> {
  const u = await factories.createUser({ subscriptionTier: tier });
  created.users.push(u.id);
  return u.id;
}

async function root(values: typeof wallets.$inferInsert): Promise<string> {
  const [w] = await db.insert(wallets).values(values).returning({ id: wallets.id });
  created.rootWallets.push(w.id);
  return w.id;
}

const scope = () => inArray(wallets.id, [...created.rootWallets, ...created.childWallets]);

describe('credit liability against Postgres', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: walletFundingLegs.id }).from(walletFundingLegs).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('credit-liability.integration.test.ts', error);
      dbAvailable = false;
    }
    process.env.DEPLOYMENT_MODE = 'cloud';
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (!dbAvailable) return;
    if (created.users.length) await db.delete(creditLedger).where(inArray(creditLedger.userId, created.users));
    if (created.usageLogIds.length) await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.id, created.usageLogIds));
    const everyWallet = [...created.childWallets, ...created.rootWallets];
    if (everyWallet.length) await db.delete(creditLedger).where(inArray(creditLedger.walletId, everyWallet));
    if (created.childWallets.length) await db.delete(wallets).where(inArray(wallets.id, created.childWallets));
    if (created.rootWallets.length) await db.delete(wallets).where(inArray(wallets.id, created.rootWallets));
    if (created.drives.length) {
      await db.delete(driveMembers).where(inArray(driveMembers.driveId, created.drives));
      await db.delete(drives).where(inArray(drives.id, created.drives));
    }
    if (created.orgs.length) await db.delete(organizations).where(inArray(organizations.id, created.orgs));
    if (created.users.length) await db.delete(users).where(inArray(users.id, created.users));
  });

  it('MON-7 (partial) an org pool with outstanding grants raises included credit liability; its allocation to a drive wallet and a donation into it never count twice', async () => {
    if (!dbAvailable) return;
    const pro = await user('pro');
    const free = await user('free');
    await root({ ownerType: 'user', userId: pro, monthlyRemainingCents: 900 });
    await root({ ownerType: 'user', userId: free, monthlyRemainingCents: 500 });

    // Personal roots only: 900 paid grant + 500 starter grant.
    const personalOnly = await readCreditLiability(scope());
    expect(personalOnly).toMatchObject({
      includedCreditLiabilityCents: 1400,
      personalIncludedCents: 1400,
      starterGrantIncludedCents: 500,
      orgPoolIncludedCents: 0,
      totalLiabilityCents: 1400,
      userCount: 2,
      orgPoolCount: 0,
    });

    // An org pool refilled with 4,800 (Business + 3 seats × 60%) and not yet spent.
    const [org] = await db
      .insert(organizations)
      .values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: pro })
      .returning();
    created.orgs.push(org.id);
    const pool = await root({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 4800 });

    const withPool = await readCreditLiability(scope());
    expect(withPool.includedCreditLiabilityCents).toBe(6200);
    expect(withPool.orgPoolIncludedCents).toBe(4800);
    expect(withPool.orgPoolCount).toBe(1);
    // The pre-fix query (personal roots only) reads 1,400 for the same rows: 4,800 under-reported.
    const [personalRootsOnly] = await db
      .select({ cents: sql<number>`COALESCE(SUM(${wallets.monthlyRemainingCents}), 0)::int` })
      .from(wallets)
      .where(and(isPersonalRootWallet(), scope()));
    expect(personalRootsOnly.cents).toBe(1400);

    // The pool allocates 3,000 a month to an org drive's wallet. No money moves: the child
    // draws on the pool as it spends, so liability is unchanged.
    const drive = await factories.createDrive(pro, { orgId: org.id });
    created.drives.push(drive.id);
    await factories.createDriveMembers(drive.id, [pro], { acceptedAt: new Date() });
    const [child] = await db
      .insert(wallets)
      .values({ ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: drive.id, parentWalletId: pool, monthlyAllowanceCents: 3000 })
      .returning({ id: wallets.id });
    created.childWallets.push(child.id);

    const allocated = await readCreditLiability(scope());
    expect(allocated.includedCreditLiabilityCents).toBe(6200);
    expect(allocated.totalLiabilityCents).toBe(6200);

    // A member donates 400 through the real path: drawn from their monthly grant into a
    // leg on the drive wallet. It is counted once, where it now sits: the total holds.
    expect(
      await donateToDriveWallet({ donorUserId: pro, targetWalletId: child.id, amountCents: 400, donationId: createId() }),
    ).toMatchObject({ kind: 'donated', amountCents: 400 });
    const [proRootAfter] = await db.select().from(wallets).where(and(eq(wallets.userId, pro), isPersonalRootWallet()));
    expect(proRootAfter.monthlyRemainingCents).toBe(500);

    const donated = await readCreditLiability(scope());
    // MONEY-4: the donation drew the donor's monthly GRANT, and the leg records that
    // composition. The 400 stays included where it now sits — the leg — instead of
    // dropping out of included liability into cash: included holds, purchased is
    // unchanged, and the total never moves.
    expect(donated).toMatchObject({
      includedCreditLiabilityCents: 6200,
      personalIncludedCents: 1000,
      orgPoolIncludedCents: 4800,
      topupRemainingCents: 0,
      totalLiabilityCents: 6200,
      userCount: 2,
      orgPoolCount: 1,
    });
  });

  it('MONEY-4 a mixed donation keeps grant and purchase apart through the leg, and spending it draws both sides', async () => {
    if (!dbAvailable) return;
    const pro = await user('pro');
    // 100 of grant + 50 of cash on the donor root.
    const donorRoot = await root({ ownerType: 'user', userId: pro, monthlyRemainingCents: 100, topupRemainingCents: 50 });
    const drive = await factories.createDrive(pro);
    created.drives.push(drive.id);
    const [child] = await db
      .insert(wallets)
      .values({ ownerType: 'user', userId: pro, subjectType: 'drive', subjectId: drive.id, parentWalletId: donorRoot, topupRemainingCents: 0 })
      .returning({ id: wallets.id });
    created.childWallets.push(child.id);

    const before = await readCreditLiability(scope());

    // Donate 150: the plan draws the root monthly FIRST (100 grant), then cash (50).
    expect(
      await donateToDriveWallet({ donorUserId: pro, targetWalletId: child.id, amountCents: 150, donationId: createId() }),
    ).toMatchObject({ kind: 'donated', amountCents: 150 });

    // Transfer invariance: the 100 grant is still included — on the leg now, not the
    // root — and the 50 cash is still purchased. Before MONEY-4 the grant part fell out
    // of included into purchased (−100/+150); every delta is now zero.
    const [leg] = await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, child.id));
    expect(leg).toMatchObject({ remainingCents: 150, includedCents: 100 });
    const moved = await readCreditLiability(scope());
    expect(moved.includedCreditLiabilityCents - before.includedCreditLiabilityCents).toBe(0);
    expect(moved.topupRemainingCents - before.topupRemainingCents).toBe(0);
    expect(moved.totalLiabilityCents - before.totalLiabilityCents).toBe(0);

    // Spend 60 of the leg through the real settle: the draw carries composition with it —
    // 40 included + 20 purchased — so both sides fall by exactly what was consumed.
    const [usageLog] = await db.insert(aiUsageLogs).values({
      userId: pro, provider: 'openrouter', model: 'e2e/stub', cost: 0.6, timestamp: new Date(),
    }).returning({ id: aiUsageLogs.id });
    created.usageLogIds.push(usageLog.id);
    expect(await consumeCredits({ userId: pro, walletId: child.id, costDollars: 0.6, aiUsageLogId: usageLog.id, markupBpsOverride: 10_000 })).toBe('settled');

    const [legAfter] = await db.select().from(walletFundingLegs).where(eq(walletFundingLegs.walletId, child.id));
    expect(legAfter).toMatchObject({ remainingCents: 90, includedCents: 60 });
    const spent = await readCreditLiability(scope());
    expect(spent.includedCreditLiabilityCents - moved.includedCreditLiabilityCents).toBe(-40);
    expect(spent.topupRemainingCents - moved.topupRemainingCents).toBe(-20);
    expect(spent.totalLiabilityCents - moved.totalLiabilityCents).toBe(-60);
  });
});

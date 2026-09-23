/**
 * Automations spend the drive wallet only, against a real Postgres (Spec SPEND-6, X-6): the
 * REAL canConsumeAI and consumeCredits, with ORGS_ENABLED on, over a small Northwind
 * (Sequence Spec fixture): the org pool, Product's drive wallet under it, and Marcus, who
 * created Product's weekly digest workflow and holds his own credits.
 *
 * What must hold: a person-less run (a workflow, a trigger, a channel mention) names the
 * drive as its consumer; it reserves and settles on Product's wallet, and when that wallet
 * cannot cover the run it is skipped and logged — no hold, no ledger row, and above all
 * never Marcus's own credits, however well funded they are. The same holds on a personal
 * drive with no wallet: its lead's credits are never reached.
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 * Deletes every row it creates, children before parents, users last, and ends the pool.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { organizations, orgMembers } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { loggers } from '../../logging/logger-config';
import { canConsumeAI } from '../credit-gate';
import { consumeCredits } from '../credit-consume';
import { automationSpend } from '../spend-target';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

interface World {
  orgId: string;
  productId: string;
  marcusDriveId: string;
  marcusId: string;
  poolId: string;
  productWalletId: string;
  marcusWalletId: string;
  userIds: string[];
}

let world: World | null = null;

async function build(input: { productAllocationCents: number | null; productStatus?: 'active' | 'paused' }): Promise<World> {
  const jono = await factories.createUser({ name: 'Jono', subscriptionTier: 'free' });
  const marcus = await factories.createUser({ name: 'Marcus Oyelaran', subscriptionTier: 'free' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id }).returning();
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(jono.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
  // Marcus's own personal drive, which has no drive wallet.
  const marcusDrive = await factories.createDrive(marcus.id, { name: 'Marcus notes', slug: `marcus-${createId()}` });

  const [poolWallet] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, monthlyRemainingCents: 5_000 }).returning();
  const productWalletId = input.productAllocationCents === null
    ? ''
    : (await db.insert(wallets).values({
        ownerType: 'org',
        orgId: org.id,
        subjectType: 'drive',
        subjectId: product.id,
        parentWalletId: poolWallet.id,
        monthlyAllowanceCents: input.productAllocationCents,
        status: input.productStatus ?? 'active',
      }).returning())[0].id;
  // Marcus's own credits: well funded, with a stamped period so the gate does not grant into it.
  const [marcusWallet] = await db.insert(wallets).values({
    userId: marcus.id,
    monthlyRemainingCents: 5_000,
    monthlyAllowanceCents: 5_000,
    monthlyPeriodStart: new Date(),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  return {
    orgId: org.id,
    productId: product.id,
    marcusDriveId: marcusDrive.id,
    marcusId: marcus.id,
    poolId: poolWallet.id,
    productWalletId,
    marcusWalletId: marcusWallet.id,
    userIds: [jono.id, marcus.id],
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  // Child wallets before their parent (parentWalletId has no cascade), then the rest.
  await db.delete(wallets).where(eq(wallets.parentWalletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(drives).where(inArray(drives.id, [w.productId, w.marcusDriveId]));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const walletRow = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];
const holdsOf = (userId: string) => db.select().from(creditHolds).where(eq(creditHolds.userId, userId));
const ledgerOf = (userId: string) => db.select().from(creditLedger).where(eq(creditLedger.userId, userId));

describe('automations spend the drive wallet only (orgs on, real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('automation-spend.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  beforeEach(() => {
    process.env.DEPLOYMENT_MODE = 'cloud';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (world) await teardown(world);
    world = null;
  });

  afterAll(async () => {
    await pool.end();
  });

  it('SPEND-6 (partial) X-6 (partial) with only the person funded and the drive wallet empty, the run is skipped, logged, and nothing is held or charged against the person', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 0 });
    const info = vi.spyOn(loggers.ai, 'info');

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: automationSpend(world.productId), skipDailyCap: true });

    expect(gate).toEqual({
      allowed: false,
      reason: 'source_refused',
      refusal: { source: 'drive_wallet', reason: 'drive_wallet_empty', options: [] },
    });
    expect(info).toHaveBeenCalledWith('automation run skipped', {
      driveId: world.productId,
      walletId: world.productWalletId,
      reason: 'drive_wallet_empty',
    });
    expect(await holdsOf(world.marcusId)).toEqual([]);
    expect(await ledgerOf(world.marcusId)).toEqual([]);
    expect((await walletRow(world.marcusWalletId)).monthlyRemainingCents).toBe(5_000);
    expect((await walletRow(world.poolId)).monthlyRemainingCents).toBe(5_000);
  });

  it('SPEND-6 (partial) a paused drive wallet skips the run and reserves nothing', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000, productStatus: 'paused' });

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: automationSpend(world.productId), skipDailyCap: true });

    expect(gate).toMatchObject({ allowed: false, refusal: { source: 'drive_wallet', reason: 'drive_wallet_paused' } });
    expect(await holdsOf(world.marcusId)).toEqual([]);
  });

  it('SPEND-6 (partial) a drive with no wallet skips the run; neither the org pool nor the person is reached', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: null });

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: automationSpend(world.productId), skipDailyCap: true });

    expect(gate).toMatchObject({ allowed: false, refusal: { source: 'drive_wallet', reason: 'no_drive_wallet' } });
    expect(await holdsOf(world.marcusId)).toEqual([]);
    expect(await ledgerOf(world.marcusId)).toEqual([]);
  });

  it('SPEND-6 (partial) on a personal drive with no wallet an automation is skipped; its lead\'s own credits are never reached', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000 });

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: automationSpend(world.marcusDriveId), skipDailyCap: true });

    expect(gate).toMatchObject({ allowed: false, refusal: { source: 'drive_wallet', reason: 'no_drive_wallet' } });
    expect(await holdsOf(world.marcusId)).toEqual([]);
    expect((await walletRow(world.marcusWalletId)).monthlyRemainingCents).toBe(5_000);
  });

  it('SPEND-6 (partial) WAL-5 (partial) a funded drive wallet holds the run and settles its charge; the person\'s credits are untouched', async () => {
    if (!dbAvailable) return;
    world = await build({ productAllocationCents: 1_000 });

    const gate = await canConsumeAI(world.marcusId, 'free', { spend: automationSpend(world.productId), skipDailyCap: true });
    expect(gate).toMatchObject({ allowed: true, walletId: world.productWalletId, spendSource: 'drive_wallet', entitlementTier: 'business' });
    expect((await holdsOf(world.marcusId)).map((h) => h.walletId)).toEqual([world.productWalletId]);

    const [log] = await db.insert(aiUsageLogs).values({ userId: world.marcusId, provider: 'openrouter', model: 'm', cost: 0.1 }).returning({ id: aiUsageLogs.id });
    const status = await consumeCredits({ aiUsageLogId: log.id, userId: world.marcusId, costDollars: 0.1, holdId: gate.holdId, walletId: gate.walletId });
    expect(status).toBe('settled');

    expect((await walletRow(world.productWalletId)).spentCents).toBe(15);
    expect((await walletRow(world.marcusWalletId)).monthlyRemainingCents).toBe(5_000);
    const ledger = await ledgerOf(world.marcusId);
    expect(ledger.map((r) => [r.entryType, r.walletId])).toEqual([['usage', world.productWalletId]]);
  });
});

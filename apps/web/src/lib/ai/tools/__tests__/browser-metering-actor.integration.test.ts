/**
 * Review #2760 P1, the BROWSER site: the browser's compute is charged to, and capped against, the
 * person driving it — never the drive's owner or the session's owner. Ben at his cap cannot run a
 * browser in a session whose billing names Anna; under his cap it is his allowance that pays.
 * Through the REAL meter (`createBrowserMeter` with its real primitives) against Postgres.
 *
 * Requires DATABASE_URL → a migrated Postgres. Every row it creates is deleted.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
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
import { DEFAULT_SEAT_ALLOWANCE_CENTS } from '@pagespace/lib/billing/wallet-core';
import { ensureTestDb } from '@/test/ensure-test-db';
import { createBrowserMeter, type BrowserBilling } from '../browser-metering-adapter';

const originalMode = process.env.DEPLOYMENT_MODE;

interface World {
  orgId: string;
  driveId: string;
  poolId: string;
  annaId: string;
  benId: string;
  userIds: string[];
}
let world: World | null = null;

/** Northwind: Anna owns a session in the org drive; Ben is a drive-mate. Both are members. */
async function build(): Promise<World> {
  const lead = await factories.createUser({ name: 'Jono (lead)', subscriptionTier: 'free' });
  const anna = await factories.createUser({ name: 'Anna (session owner)', subscriptionTier: 'free' });
  const ben = await factories.createUser({ name: 'Ben (drive-mate)', subscriptionTier: 'free' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: lead.id }).returning();
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: lead.id, role: 'OWNER' },
    { orgId: org.id, userId: anna.id, role: 'MEMBER' },
    { orgId: org.id, userId: ben.id, role: 'MEMBER' },
  ]);
  const drive = await factories.createDrive(lead.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  const [poolWallet] = await db.insert(wallets).values({
    ownerType: 'org',
    orgId: org.id,
    monthlyRemainingCents: 900_000,
    monthlyPeriodStart: new Date(Date.now() - 5 * 86_400_000),
    monthlyPeriodEnd: new Date(Date.now() + 25 * 86_400_000),
  }).returning();
  return { orgId: org.id, driveId: drive.id, poolId: poolWallet.id, annaId: anna.id, benId: ben.id, userIds: [lead.id, anna.id, ben.id] };
}

async function teardown(w: World): Promise<void> {
  await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, w.userIds));
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(drives).where(eq(drives.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

/** `userId` has already spent their whole monthly allowance of the pool on AI this period. */
async function atCap(w: World, userId: string): Promise<void> {
  const cents = DEFAULT_SEAT_ALLOWANCE_CENTS;
  await db.insert(creditLedger).values({ userId, walletId: w.poolId, entryType: 'usage', bucket: 'monthly', amountCents: -cents, appliedCents: -cents, chargeMillicents: cents * 1000, consumeStatus: 'applied', spendKind: 'ai' });
}

/** Every charge and reservation the pool holds for `userId`: none means their allowance is untouched. */
async function poolRowsOf(w: World, userId: string) {
  const ledger = (await db.select().from(creditLedger).where(eq(creditLedger.userId, userId))).filter((r) => r.walletId === w.poolId);
  const holds = await db.select().from(creditHolds).where(eq(creditHolds.userId, userId));
  return { ledger, holds };
}

const billingFor = (w: World, actorId: string): BrowserBilling => ({ driveId: w.driveId, ownerId: w.annaId, actorId, agentPageId: null, conversationId: `conv-${createId()}` });

describe('the browser is charged to the person driving it, never the owner (review #2760 P1)', () => {
  beforeAll(async () => {
    await ensureTestDb();
  });
  beforeEach(() => {
    process.env.DEPLOYMENT_MODE = 'cloud';
  });
  afterEach(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (world) await teardown(world);
    world = null;
  });
  afterAll(async () => {
    await pool.end();
  });

  it('WAL-2 (partial) browser: Ben, at his cap, opening a browser in a session billed to Anna is refused with the cap message, and Anna\'s allowance is untouched', async () => {
    const w = (world = await build());
    await atCap(w, w.benId);

    const opened = await createBrowserMeter().open(billingFor(w, w.benId));

    expect(opened).toMatchObject({ ok: false, reason: expect.stringMatching(/used your allowance/) });
    expect(await db.select().from(creditHolds).where(inArray(creditHolds.userId, [w.annaId, w.benId]))).toEqual([]);
    expect(await poolRowsOf(w, w.annaId)).toEqual({ ledger: [], holds: [] });
  });

  it('WAL-2 (partial) browser: Ben, under his cap, holds and settles on HIS allowance — never Anna\'s', async () => {
    const w = (world = await build());
    const meter = createBrowserMeter();
    const billing = billingFor(w, w.benId);

    const opened = await meter.open(billing);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.hold.charge).toEqual({ kind: 'org', orgId: w.orgId, userId: w.benId });
    await meter.close({ billing, hold: opened.hold, activeSeconds: 60, shape: { cpus: 1, memoryGB: 1 }, substrate: 'test' });

    const usage = (await db.select().from(creditLedger).where(eq(creditLedger.walletId, w.poolId))).filter((r) => r.entryType === 'usage');
    expect(usage.map((r) => [r.userId, r.spendKind])).toEqual([[w.benId, 'compute']]);
    expect(await poolRowsOf(w, w.annaId)).toEqual({ ledger: [], holds: [] });
  });
});

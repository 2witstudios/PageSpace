/**
 * Review #2760 P1: compute is charged to, and capped against, THE PERSON WHO CAUSES IT — never the
 * session's owner. A drive session is shared with every drive member, so keying the per-member cap
 * on the owner let a member at their cap keep running compute in a drive-mate's session, on the
 * drive-mate's allowance. This is the reviewer's scenario for the agent sandbox tool site, through
 * the REAL tool-runner metering (`withMachineBilling`) and the REAL billing deps against Postgres.
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
import { requireDb } from '@pagespace/db/test/require-db';
import { defaultSandboxBillingDeps } from '../../services/sandbox/sandbox-billing';
import { withMachineBilling, type SandboxActorContext, type SandboxRunDeps } from '../../services/sandbox/tool-runners';
import { loadSeatCapFacts } from '../seat-allowance';
import { DEFAULT_SEAT_ALLOWANCE_CENTS } from '../wallet-core';

let dbAvailable = false;
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

async function seatOf(w: World, userId: string) {
  const [poolRow] = await db.select().from(wallets).where(eq(wallets.id, w.poolId));
  return loadSeatCapFacts(db, { poolId: w.poolId, poolPeriodStart: poolRow.monthlyPeriodStart, userId, policySeatAllowanceCents: null, now: new Date() });
}

/** The real tool-runner metering, with the session resolved to ANNA's session in the org drive. */
function toolDeps(w: World): SandboxRunDeps {
  let now = Date.now();
  return {
    billing: defaultSandboxBillingDeps,
    resolveBillingSession: async () => ({ workspaceId: `ws-${createId()}`, driveId: w.driveId, ownerId: w.annaId }),
    now: () => new Date((now += 5_000)),
  } as Pick<SandboxRunDeps, 'billing' | 'resolveBillingSession' | 'now'> as SandboxRunDeps;
}
const ctxFor = (w: World, userId: string): SandboxActorContext => ({ userId, tenantId: userId, driveId: w.driveId, ownerId: w.annaId, conversationId: `conv-${createId()}`, actorEmail: `${userId}@example.test`, tier: 'business' });

describe('compute is charged to the person who causes it, never the session owner (review #2760 P1)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('compute-actor.integration.test.ts', error);
      dbAvailable = false;
    }
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

  it('WAL-2 (partial) agent tools: Ben, at his cap, running a tool in ANNA\'s session is refused — nothing runs, and Anna\'s allowance is untouched', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    await atCap(w, w.benId);
    let ran = false;

    const result = await withMachineBilling(ctxFor(w, w.benId), toolDeps(w), async () => {
      ran = true;
      return { success: true as const };
    });

    expect(result).toMatchObject({ success: false, reason: 'org_member_cap_reached' });
    expect(ran).toBe(false);
    expect(await db.select().from(creditHolds).where(inArray(creditHolds.userId, [w.annaId, w.benId]))).toEqual([]);
    expect((await seatOf(w, w.annaId)).usage).toEqual({ periodChargedMillicents: 0, periodReservedCents: 0, dayChargedMillicents: 0 });
  });

  it('WAL-2 (partial) agent tools: Ben, under his cap, running a tool in Anna\'s session is charged to BEN\'s allowance — never Anna\'s', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    const result = await withMachineBilling(ctxFor(w, w.benId), toolDeps(w), async () => ({ success: true as const }));

    expect(result).toMatchObject({ success: true });
    const usage = (await db.select().from(creditLedger).where(eq(creditLedger.walletId, w.poolId))).filter((r) => r.entryType === 'usage');
    expect(usage.map((r) => [r.userId, r.spendKind])).toEqual([[w.benId, 'compute']]);
    expect((await seatOf(w, w.benId)).usage.periodChargedMillicents).toBeGreaterThan(0);
    expect((await seatOf(w, w.annaId)).usage.periodChargedMillicents).toBe(0);
  });
});

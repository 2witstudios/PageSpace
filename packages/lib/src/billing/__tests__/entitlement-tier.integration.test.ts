/**
 * The tier the shared pro-model gate asks for (resolveEntitlementTier, consumed by apps/web model-entitlement.ts for
 * consult, /v1, workflows, mention replies and agent consults) is payer-aware, against a REAL Postgres (POL-8, WAL-8):
 * a Free member spending an org drive's seat allowance or drive wallet, or an automation on that drive wallet, carries
 * the org's Business tier; the same member on their own credits keeps their own Free tier; a lapsed org confers none.
 * Read-only: no hold is placed. Every row is deleted; the pool is ended.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { creditHolds } from '@pagespace/db/schema/credits';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { resolveEntitlementTier } from '../credit-gate';
import { automationSpend, driveSpend } from '../spend-target';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

interface World { orgId: string; driveId: string; memberId: string; poolId: string; userIds: string[] }
let w: World | null = null;

async function build(): Promise<World> {
  const owner = await factories.createUser({ subscriptionTier: 'free' });
  const member = await factories.createUser({ subscriptionTier: 'free' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind', slug: `nw-${createId()}`, ownerId: owner.id, stripeCustomerId: `cus_${createId()}` }).returning();
  await factories.createOrgSubscription(org.id);
  await db.insert(orgMembers).values([{ orgId: org.id, userId: owner.id, role: 'OWNER' }, { orgId: org.id, userId: member.id, role: 'MEMBER' }]);
  const drive = await factories.createDrive(owner.id, { orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(drive.id, member.id, { source: 'org' });
  const [poolWallet] = await db.insert(wallets).values({
    ownerType: 'org', orgId: org.id, monthlyRemainingCents: 5_000,
    monthlyPeriodStart: new Date(Date.now() - 86_400_000), monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: drive.id, parentWalletId: poolWallet.id, monthlyAllowanceCents: 1_000, status: 'active' });
  await db.insert(wallets).values({ userId: member.id, monthlyRemainingCents: 5_000, monthlyAllowanceCents: 5_000, monthlyPeriodStart: new Date(), monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000) });
  return { orgId: org.id, driveId: drive.id, memberId: member.id, poolId: poolWallet.id, userIds: [owner.id, member.id] };
}

async function teardown(world: World): Promise<void> {
  await db.delete(creditHolds).where(inArray(creditHolds.userId, world.userIds));
  await db.delete(wallets).where(eq(wallets.parentWalletId, world.poolId));
  await db.delete(wallets).where(eq(wallets.id, world.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, world.userIds));
  await db.delete(drives).where(eq(drives.orgId, world.orgId));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, world.orgId));
  await db.delete(organizations).where(eq(organizations.id, world.orgId));
  await db.delete(users).where(inArray(users.id, world.userIds));
}

beforeAll(async () => {
  try {
    await db.select({ id: organizations.id }).from(organizations).limit(1);
    dbAvailable = true;
  } catch (error) {
    requireDb('entitlement-tier.integration.test.ts', error);
  }
});
beforeEach(async () => {
  process.env.DEPLOYMENT_MODE = 'cloud';
  if (dbAvailable) w = await build();
});
afterEach(async () => {
  if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
  else process.env.DEPLOYMENT_MODE = originalMode;
  if (w) await teardown(w);
  w = null;
});
afterAll(async () => {
  if (dbAvailable) await pool.end();
});

describe('the pro-model gate\'s tier follows whoever funds the call', () => {
  it('POL-8 (partial) WAL-8 (partial) a Free member on the org\'s seat allowance or drive wallet, and an automation on that wallet, carry Business; on their own credits, their own Free', async () => {
    if (!w) return;
    expect(await resolveEntitlementTier(w.memberId, 'free', driveSpend(w.driveId, 'seat_allowance'))).toBe('business');
    expect(await resolveEntitlementTier(w.memberId, 'free', driveSpend(w.driveId, 'drive_wallet'))).toBe('business');
    expect(await resolveEntitlementTier(w.memberId, 'free', automationSpend(w.driveId))).toBe('business');
    expect(await resolveEntitlementTier(w.memberId, 'free', driveSpend(w.driveId, 'own_credits'))).toBe('free');
    expect(await db.select().from(creditHolds).where(inArray(creditHolds.userId, w.userIds))).toEqual([]);
  });

  it('POL-8 (partial) WAL-8 (partial) a lapsed org confers no paid tier on its wallet legs', async () => {
    if (!w) return;
    await db.update(orgSubscriptions).set({ status: 'canceled' }).where(eq(orgSubscriptions.orgId, w.orgId));
    expect(await resolveEntitlementTier(w.memberId, 'free', automationSpend(w.driveId))).not.toBe('business');
  });
});

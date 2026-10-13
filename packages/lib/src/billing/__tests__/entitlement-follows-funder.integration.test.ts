/**
 * The tier that governs a call is its FUNDER's (Spec WAL-8) — real Postgres, the real resolver and
 * gate, orgs on.
 *
 * Every model-call surface asks one resolver for the tier its pro-model (and voice) entitlement
 * is judged on: the gate's `entitlementTier` when it gates first, `resolveEntitlementTier` on the
 * same spend target when it must decide before reserving (consult, /v1, workflows, mentions,
 * ask_agent, a realtime voice call). Both answer the wallet's ROOT owner's tier:
 *
 *   - inside an org drive, the ORG's tier (Business), on its drive wallet and on a seat — and
 *     none while the org is lapsed (SEAT-9);
 *   - on a personal drive's wallet leg, the drive owner's tier — the person funding it;
 *   - on the consumer's own credits, the consumer's own tier, wherever they are.
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one. Deletes every row it
 * creates, children before parents, users last.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { organizations, orgMembers, orgSubscriptions } from '@pagespace/db/schema/organizations';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { canConsumeAI, resolveEntitlementTier } from '../credit-gate';
import { releaseHold } from '../credit-consume';
import { PERSONAL_SPEND, automationSpend, driveSpend, type SpendTarget } from '../spend-target';
import type { SubscriptionTier } from '../subscription-tiers';

vi.mock('../../organizations/orgs-enabled', () => ({ ORGS_ENABLED: true }));

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

interface World {
  orgId: string;
  marcusId: string;
  priyaId: string;
  anaId: string;
  jonoId: string;
  productId: string;
  priyaDriveId: string;
  poolId: string;
  userIds: string[];
}

let world: World | null = null;

async function personalRoot(userId: string, cents: number): Promise<string> {
  const [row] = await db.insert(wallets).values({
    userId,
    monthlyRemainingCents: cents,
    monthlyAllowanceCents: cents,
    monthlyPeriodStart: new Date(),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  return row.id;
}

async function build(): Promise<World> {
  const jono = await factories.createUser({ name: 'Jono', subscriptionTier: 'free' });
  const marcus = await factories.createUser({ name: 'Marcus Oyelaran', subscriptionTier: 'free' });
  const priya = await factories.createUser({ name: 'Priya (Pro)', subscriptionTier: 'pro' });
  const ana = await factories.createUser({ name: 'Ana (Free)', subscriptionTier: 'free' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id }).returning();
  await factories.createOrgSubscription(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(jono.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
  const priyaDrive = await factories.createDrive(priya.id, { name: 'Priya notes', slug: `priya-${createId()}` });
  await factories.createDriveMember(priyaDrive.id, ana.id, { source: 'invite' });

  const [pool] = await db.insert(wallets).values({
    ownerType: 'org',
    orgId: org.id,
    monthlyRemainingCents: 20_000,
    monthlyPeriodStart: new Date(Date.now() - 10 * 86_400_000),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: product.id, parentWalletId: pool.id, monthlyAllowanceCents: 2_000 });

  await personalRoot(marcus.id, 5_000);
  await personalRoot(ana.id, 5_000);
  const priyaRoot = await personalRoot(priya.id, 5_000);
  // Priya funds a wallet on her personal drive from her own credits: the leg Ana may spend.
  await db.insert(wallets).values({ ownerType: 'user', userId: priya.id, subjectType: 'drive', subjectId: priyaDrive.id, parentWalletId: priyaRoot, monthlyAllowanceCents: 1_000 });

  return {
    orgId: org.id,
    marcusId: marcus.id,
    priyaId: priya.id,
    anaId: ana.id,
    jonoId: jono.id,
    productId: product.id,
    priyaDriveId: priyaDrive.id,
    poolId: pool.id,
    userIds: [jono.id, marcus.id, priya.id, ana.id],
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  await db.delete(wallets).where(eq(wallets.parentWalletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.subjectId, [w.productId, w.priyaDriveId]));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(drives).where(inArray(drives.id, [w.productId, w.priyaDriveId]));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

/**
 * The tier both ways a surface can ask — the read-only resolver a pre-reserving surface uses, and
 * the gate's own answer for a surface that gates first — which must agree. The hold is released.
 */
async function funderTier(userId: string, consumerTier: SubscriptionTier, spend: SpendTarget): Promise<{ resolved: SubscriptionTier; gated: SubscriptionTier | undefined }> {
  const resolved = await resolveEntitlementTier(userId, consumerTier, spend);
  const gate = await canConsumeAI(userId, consumerTier, { spend, estCostCents: 5 });
  expect(gate.allowed).toBe(true);
  if (gate.holdId) await releaseHold(gate.holdId);
  return { resolved, gated: gate.entitlementTier };
}

describe('WAL-8 the tier that governs a call is its funding wallet\'s root owner\'s', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('entitlement-follows-funder.integration.test.ts', error);
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

  it('WAL-8 inside an org drive a Free member carries the ORG\'s tier on its drive wallet, on a seat, and in an automation there — the gate and the pre-read agree', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    expect(await funderTier(w.marcusId, 'free', driveSpend(w.productId, 'drive_wallet'))).toEqual({ resolved: 'business', gated: 'business' });
    expect(await funderTier(w.marcusId, 'free', driveSpend(w.productId, 'seat_allowance'))).toEqual({ resolved: 'business', gated: 'business' });
    expect(await resolveEntitlementTier(w.marcusId, 'free', automationSpend(w.productId))).toBe('business');
  });

  it('WAL-8 on a personal drive\'s wallet leg a Free collaborator carries the tier of the drive\'s owner, who funds it', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    expect(await funderTier(w.anaId, 'free', driveSpend(w.priyaDriveId, 'drive_wallet'))).toEqual({ resolved: 'pro', gated: 'pro' });
  });

  it('WAL-8 on their own credits a person keeps their own tier — in an org drive, in someone\'s personal drive, and with no drive at all', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    expect(await funderTier(w.marcusId, 'free', driveSpend(w.productId, 'own_credits'))).toEqual({ resolved: 'free', gated: 'free' });
    expect(await funderTier(w.anaId, 'free', driveSpend(w.priyaDriveId, 'own_credits'))).toEqual({ resolved: 'free', gated: 'free' });
    expect(await funderTier(w.priyaId, 'pro', PERSONAL_SPEND)).toEqual({ resolved: 'pro', gated: 'pro' });
  });

  it('WAL-8 a LAPSED org confers no paid tier on its legs (SEAT-9)', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());
    await db.update(orgSubscriptions).set({ status: 'canceled' }).where(eq(orgSubscriptions.orgId, w.orgId));

    expect(await resolveEntitlementTier(w.marcusId, 'free', driveSpend(w.productId, 'drive_wallet'))).toBe('free');
  });
});

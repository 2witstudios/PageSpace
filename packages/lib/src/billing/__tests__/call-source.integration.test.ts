/**
 * Every AI call inside a drive names exactly one source before it runs (Spec SPEND-1) — real
 * Postgres, the real gate.
 *
 * Each entry point hands the gate the target of the session it runs in, and the gate answers ONE
 * wallet and places ONE hold on it before any model is called (nothing is charged until the call
 * settles):
 *
 *   - a chat turn, a /btw side question, a voice call or a TTS synthesis in a drive (the
 *     conversation's target, conversationSpend);
 *   - a consultation or /v1 completion (agentCallSpend);
 *   - a call that follows its turn — ask_agent's sub-agent, an image, a compaction — on the
 *     source the turn resolved (resolvedSpend);
 *   - a channel mention a person triggered (personTriggeredSpend) and an automation run by its
 *     creator (automationSpend): the drive wallet only.
 *
 * The three sources are the drive wallet, the caller's seat allowance and their own credits; a
 * guest and a personal drive simply have fewer of them.
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
import { canConsumeAI } from '../credit-gate';
import { releaseHold } from '../credit-consume';
import {
  agentCallSpend,
  automationSpend,
  conversationSpend,
  driveSpend,
  personTriggeredSpend,
  resolvedSpend,
  type SpendTarget,
} from '../spend-target';

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;

interface World {
  orgId: string;
  jonoId: string;
  marcusId: string;
  chrisId: string;
  priyaId: string;
  anaId: string;
  productId: string;
  priyaDriveId: string;
  poolId: string;
  productWalletId: string;
  anaWalletId: string;
  userIds: string[];
}

let world: World | null = null;

async function personalRoot(userId: string): Promise<string> {
  const [row] = await db.insert(wallets).values({
    userId,
    monthlyRemainingCents: 5_000,
    monthlyAllowanceCents: 5_000,
    monthlyPeriodStart: new Date(),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  return row.id;
}

async function build(): Promise<World> {
  const jono = await factories.createUser({ name: 'Jono', subscriptionTier: 'free' });
  const marcus = await factories.createUser({ name: 'Marcus Oyelaran', subscriptionTier: 'free' });
  const chris = await factories.createUser({ name: 'Chris Rowe (guest)', subscriptionTier: 'free' });
  const priya = await factories.createUser({ name: 'Priya', subscriptionTier: 'pro' });
  const ana = await factories.createUser({ name: 'Ana', subscriptionTier: 'free' });
  const [org] = await db.insert(organizations).values({ name: 'Northwind Labs', slug: `northwind-${createId()}`, ownerId: jono.id }).returning();
  await factories.createOrgSubscription(org.id);
  await db.insert(orgMembers).values([
    { orgId: org.id, userId: jono.id, role: 'OWNER' },
    { orgId: org.id, userId: marcus.id, role: 'MEMBER' },
  ]);
  const product = await factories.createDrive(jono.id, { name: 'Product', slug: `product-${createId()}`, orgId: org.id, orgVisibility: 'OPEN' });
  await factories.createDriveMember(product.id, marcus.id, { source: 'org' });
  await factories.createDriveMember(product.id, chris.id, { source: 'invite' });
  const priyaDrive = await factories.createDrive(priya.id, { name: 'Priya notes', slug: `priya-${createId()}` });
  await factories.createDriveMember(priyaDrive.id, ana.id, { source: 'invite' });

  const [pool] = await db.insert(wallets).values({
    ownerType: 'org',
    orgId: org.id,
    monthlyRemainingCents: 20_000,
    monthlyPeriodStart: new Date(Date.now() - 10 * 86_400_000),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  const [productWallet] = await db.insert(wallets).values({ ownerType: 'org', orgId: org.id, subjectType: 'drive', subjectId: product.id, parentWalletId: pool.id, monthlyAllowanceCents: 2_000 }).returning();
  await personalRoot(marcus.id);
  await personalRoot(chris.id);
  await personalRoot(priya.id);
  const anaWalletId = await personalRoot(ana.id);

  return {
    orgId: org.id,
    jonoId: jono.id,
    marcusId: marcus.id,
    chrisId: chris.id,
    priyaId: priya.id,
    anaId: ana.id,
    productId: product.id,
    priyaDriveId: priyaDrive.id,
    poolId: pool.id,
    productWalletId: productWallet.id,
    anaWalletId,
    userIds: [jono.id, marcus.id, chris.id, priya.id, ana.id],
  };
}

async function teardown(w: World): Promise<void> {
  await db.delete(creditHolds).where(inArray(creditHolds.userId, w.userIds));
  await db.delete(creditLedger).where(inArray(creditLedger.userId, w.userIds));
  await db.delete(wallets).where(eq(wallets.parentWalletId, w.poolId));
  await db.delete(wallets).where(eq(wallets.id, w.poolId));
  await db.delete(wallets).where(inArray(wallets.userId, w.userIds));
  await db.delete(drives).where(inArray(drives.id, [w.productId, w.priyaDriveId]));
  await db.delete(orgMembers).where(eq(orgMembers.orgId, w.orgId));
  await db.delete(orgSubscriptions).where(eq(orgSubscriptions.orgId, w.orgId));
  await db.delete(organizations).where(eq(organizations.id, w.orgId));
  await db.delete(users).where(inArray(users.id, w.userIds));
}

const holdsOf = (userIds: string[]) => db.select().from(creditHolds).where(inArray(creditHolds.userId, userIds));
const ledgerOf = (userIds: string[]) => db.select().from(creditLedger).where(inArray(creditLedger.userId, userIds));

/** Gate one call: exactly one new hold, on the one wallet the gate named, and nothing charged. */
async function gateOnce(w: World, userId: string, spend: SpendTarget): Promise<string> {
  const before = await holdsOf(w.userIds);
  const gate = await canConsumeAI(userId, 'free', { spend, estCostCents: 5 });
  expect(gate.allowed).toBe(true);
  expect(typeof gate.walletId).toBe('string');
  const after = await holdsOf(w.userIds);
  const added = after.filter((h) => !before.some((b) => b.id === h.id));
  expect(added).toEqual([expect.objectContaining({ id: gate.holdId, walletId: gate.walletId, userId })]);
  expect(await ledgerOf(w.userIds)).toEqual([]);
  if (gate.holdId) await releaseHold(gate.holdId);
  return gate.walletId as string;
}

describe('SPEND-1 every AI call inside a drive names one source before it runs', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('call-source.integration.test.ts', error);
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

  it('SPEND-1 every entry point\'s target in an org drive — a turn, a side question, voice, TTS, a consultation, a /v1 completion, a follow-on call, a mention, an automation — reserves one hold on one named wallet before its call, charging nothing yet', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    const turn = conversationSpend(w.productId, null);
    // Chat turns, /btw, voice and TTS: the conversation's target in its drive.
    expect(await gateOnce(w, w.marcusId, turn)).toBe(w.productWalletId);
    // Consult and /v1 from a session in the drive.
    expect(await gateOnce(w, w.marcusId, agentCallSpend({ agentDriveId: w.productId, conversationId: null, clientThreadDriveId: null, namedSessionDriveId: null }))).toBe(w.productWalletId);
    // ask_agent's sub-agent, an image, a compaction: the source the turn resolved, as a follow-on.
    expect(await gateOnce(w, w.marcusId, resolvedSpend(turn, 'drive_wallet'))).toBe(w.productWalletId);
    // A mention Marcus sent, and an automation he created: the drive wallet only.
    expect(await gateOnce(w, w.marcusId, personTriggeredSpend(w.productId))).toBe(w.productWalletId);
    expect(await gateOnce(w, w.marcusId, automationSpend(w.productId))).toBe(w.productWalletId);
  });

  it('SPEND-1 the three sources are the drive wallet, the caller\'s seat allowance and their own credits — each one wallet, chosen before the call', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    const drive = await gateOnce(w, w.marcusId, driveSpend(w.productId, 'drive_wallet'));
    const seat = await gateOnce(w, w.marcusId, driveSpend(w.productId, 'seat_allowance'));
    const own = await gateOnce(w, w.marcusId, driveSpend(w.productId, 'own_credits'));

    expect(drive).toBe(w.productWalletId);
    expect(seat).toBe(w.poolId);
    expect(new Set([drive, seat, own]).size).toBe(3);
  });

  it('SPEND-1 a guest has fewer sources — no seat — and a personal drive with no wallet has only the caller\'s own credits', async () => {
    if (!dbAvailable) return;
    const w = (world = await build());

    const guestSeat = await canConsumeAI(w.chrisId, 'free', { spend: driveSpend(w.productId, 'seat_allowance') });
    expect(guestSeat.allowed).toBe(false);
    expect(guestSeat.refusal?.options ?? []).not.toContain('seat_allowance');

    const personalWallet = await canConsumeAI(w.anaId, 'free', { spend: driveSpend(w.priyaDriveId, 'drive_wallet') });
    expect(personalWallet).toMatchObject({ allowed: false, refusal: { options: ['own_credits'] } });
    expect(await gateOnce(w, w.anaId, driveSpend(w.priyaDriveId))).toBe(w.anaWalletId);
  });
});

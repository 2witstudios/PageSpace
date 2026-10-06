/**
 * The memory cron's model calls against a real Postgres (Spec SPEND-1, SPEND-8): each one
 * reserves the person's own credits before the model runs and settles once, and a refusal
 * charges nothing and changes nothing.
 *
 * REAL: the credit gate (canConsumeAI via reserveMemoryCall), holds, settlement
 * (AIMonitoring.trackUsage → consumeCredits). Faked: the model and its provider. The call
 * under test is compactField, which returns the page content it would write (or the credit
 * refusal that stopped it); its callers write only what it returns.
 *
 * Requires DATABASE_URL → a migrated Postgres. Deletes every row it creates.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { ensureTestDb } from '@/test/ensure-test-db';

const { mockGenerateText } = vi.hoisted(() => ({ mockGenerateText: vi.fn() }));

vi.mock('ai', () => ({ generateText: mockGenerateText }));
vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn(async () => ({ model: {}, provider: 'anthropic', modelName: 'claude-3-haiku-20240307' })),
  isProviderError: (p: unknown) => typeof p === 'object' && p !== null && 'error' in p,
}));

import { sweepExpiredHolds } from '@pagespace/lib/billing/credit-backfill';
import { getCreditBalance } from '@pagespace/lib/billing/credit-balance';
import { compactField } from '../compaction-service';
import { reserveMemoryCall } from '../memory-credit';
import { withHoldAudit } from '@/test/hold-audit';

const FUNDED_CENTS = 5_000;
const ORIGINAL = 'Ada writes tersely. '.repeat(200);

interface World {
  userId: string;
  walletId: string;
}

let world: World | null = null;
const originalMode = process.env.DEPLOYMENT_MODE;

async function build(cents: number): Promise<World> {
  const user = await factories.createUser({ name: 'Ada', subscriptionTier: 'pro' });
  const [wallet] = await db.insert(wallets).values({
    userId: user.id,
    monthlyRemainingCents: cents,
    monthlyAllowanceCents: cents,
    monthlyPeriodStart: new Date(),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  return { userId: user.id, walletId: wallet.id };
}

async function teardown(w: World): Promise<void> {
  await db.delete(creditHolds).where(eq(creditHolds.userId, w.userId));
  await db.delete(creditLedger).where(eq(creditLedger.userId, w.userId));
  await db.delete(aiUsageLogs).where(eq(aiUsageLogs.userId, w.userId));
  await db.delete(wallets).where(eq(wallets.userId, w.userId));
  await db.delete(users).where(eq(users.id, w.userId));
}

const walletCents = async (w: World) => (await db.select().from(wallets).where(eq(wallets.id, w.walletId)))[0].monthlyRemainingCents;
const usageRows = async (w: World) => (await db.select().from(creditLedger).where(eq(creditLedger.userId, w.userId))).filter((r) => r.entryType === 'usage');
const liveHolds = (w: World) => db.select().from(creditHolds).where(eq(creditHolds.userId, w.userId));

describe('memory cron model calls reserve first (real Postgres)', () => {
  beforeAll(async () => {
    await ensureTestDb();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEPLOYMENT_MODE = 'cloud';
    mockGenerateText.mockResolvedValue({ text: 'Ada writes tersely.', usage: { inputTokens: 400_000, outputTokens: 3_000 } });
  });

  afterEach(async () => {
    if (world) await teardown(world);
    world = null;
    process.env.DEPLOYMENT_MODE = originalMode;
  });

  it('SPEND-1 (partial) an exhausted person\'s memory compaction calls no model, charges nothing, and keeps the page', async () => {
    world = await build(0);

    const { result, audit } = await withHoldAudit([world.userId], () => compactField((world as World).userId, 'bio', ORIGINAL));

    expect(result).toEqual({ creditRefusal: 'out_of_credits' });
    expect(audit.placed.get(world.userId)).toEqual([]);
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(await usageRows(world)).toEqual([]);
    expect(await liveHolds(world)).toEqual([]);
    expect(await walletCents(world)).toBe(0);
  });

  it('SPEND-8 (partial) a funded memory compaction settles exactly once on the person\'s own root, leaving no hold', async () => {
    world = await build(FUNDED_CENTS);

    // The usage settles off the response path (discardUsageOutcome), and its ledger row is
    // claimed 'pending' before the charge commits: wait for the settled row.
    const { result, audit } = await withHoldAudit([world.userId], () => compactField((world as World).userId, 'bio', ORIGINAL), () => vi.waitFor(async () => {
      const rows = await usageRows(world as World);
      expect(rows).toHaveLength(1);
      expect(rows[0].consumeStatus).not.toBe('pending');
    }, { timeout: 10_000, interval: 100 }));

    expect(result).toEqual({ content: 'Ada writes tersely.' });
    expect(mockGenerateText).toHaveBeenCalledOnce();
    // pa0ycktr: one model call took EXACTLY one hold, and the settle removed that hold.
    const placed = audit.placed.get(world.userId) ?? [];
    expect(placed).toHaveLength(1);
    expect(audit.removed.get(world.userId)).toEqual(placed);
    const [row] = await usageRows(world);
    expect(row.walletId).toBe(world.walletId);
    const charged = -(row.appliedCents ?? 0);
    expect(charged).toBeGreaterThan(0);
    expect(await walletCents(world)).toBe(FUNDED_CENTS - charged);
    expect(await liveHolds(world)).toEqual([]);
  });

  it('SPEND-1 (partial) a model call that throws releases its one hold: one placed, that one removed, nothing charged', async () => {
    world = await build(FUNDED_CENTS);
    mockGenerateText.mockRejectedValue(new Error('provider down'));

    const { audit } = await withHoldAudit([world.userId], () => compactField((world as World).userId, 'bio', ORIGINAL).catch(() => null), () => vi.waitFor(async () => {
      expect(await liveHolds(world as World)).toEqual([]);
    }, { timeout: 10_000, interval: 100 }));

    const placed = audit.placed.get(world.userId) ?? [];
    expect(placed).toHaveLength(1);
    expect(audit.removed.get(world.userId)).toEqual(placed);
    expect(await usageRows(world)).toEqual([]);
    expect(await walletCents(world)).toBe(FUNDED_CENTS);
  });
  it('a reservation whose settle never runs (the process died mid-call) stops counting at its expiry, and the reconcile sweep removes it without touching the wallet', async () => {
    world = await build(FUNDED_CENTS);
    const w = world;
    const reservation = await reserveMemoryCall(w.userId, { provider: 'anthropic', model: 'claude-3-haiku-20240307', inputChars: ORIGINAL.length });
    if (!reservation.allowed || !reservation.holdId) throw new Error('expected the funded call to reserve a hold');
    const [hold] = await liveHolds(w);
    expect(hold.id).toBe(reservation.holdId);
    expect(hold.estCents).toBeGreaterThan(0);
    // The reservation is what holds the person's credits back (the gate subtracts it).
    const held = await getCreditBalance(w.userId, 'pro');
    expect(held.reserved).toBe(hold.estCents);
    expect(held.spendable).toBe(FUNDED_CENTS);

    // The settle never runs and release is never called. Time passes: the hold was placed one
    // TTL ago and its expiry is behind us. (The row is aged rather than the clock moved.)
    const ttlMs = hold.expiresAt.getTime() - hold.createdAt.getTime();
    const expiredAt = new Date(Date.now() - 1_000);
    await db.update(creditHolds)
      .set({ createdAt: new Date(expiredAt.getTime() - ttlMs), expiresAt: expiredAt })
      .where(eq(creditHolds.id, hold.id));

    // Expired, it no longer reserves anything, before any sweep has run.
    const expired = await getCreditBalance(w.userId, 'pro');
    expect(expired.reserved).toBe(0);
    expect(expired.spendable).toBe(FUNDED_CENTS);

    // The cron's own sweep (backfillCredits → sweepExpiredHolds), scoped to this person so a
    // shared CI database's other workers keep their holds. A bystander's expired hold proves it.
    const bystander = await build(FUNDED_CENTS);
    try {
      await db.insert(creditHolds).values({ userId: bystander.userId, walletId: bystander.walletId, estCents: 1, expiresAt: expiredAt });
      expect(await sweepExpiredHolds({ userIds: [w.userId] })).toBe(1);
      expect(await liveHolds(w)).toEqual([]);
      expect(await liveHolds(bystander)).toHaveLength(1);
    } finally {
      await teardown(bystander);
    }
    // Money invariant: a hold never moved money, so the wallet and the ledger are as they were.
    expect(await walletCents(w)).toBe(FUNDED_CENTS);
    expect(await db.select().from(creditLedger).where(eq(creditLedger.userId, w.userId))).toEqual([]);
    expect(await getCreditBalance(w.userId, 'pro')).toMatchObject({ spendable: FUNDED_CENTS, reserved: 0 });
  });
});

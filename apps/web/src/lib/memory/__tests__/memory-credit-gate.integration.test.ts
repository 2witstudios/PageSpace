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

import { compactField } from '../compaction-service';

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

    const result = await compactField(world.userId, 'bio', ORIGINAL);

    expect(result).toEqual({ creditRefusal: 'out_of_credits' });
    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(await usageRows(world)).toEqual([]);
    expect(await liveHolds(world)).toEqual([]);
    expect(await walletCents(world)).toBe(0);
  });

  it('SPEND-8 (partial) a funded memory compaction settles exactly once on the person\'s own root, leaving no hold', async () => {
    world = await build(FUNDED_CENTS);

    const result = await compactField(world.userId, 'bio', ORIGINAL);

    expect(result).toEqual({ content: 'Ada writes tersely.' });
    expect(mockGenerateText).toHaveBeenCalledOnce();
    // The usage settles off the response path (discardUsageOutcome), and its ledger row is
    // claimed 'pending' before the charge commits: wait for the settled row.
    await vi.waitFor(async () => {
      const rows = await usageRows(world as World);
      expect(rows).toHaveLength(1);
      expect(rows[0].consumeStatus).not.toBe('pending');
    }, { timeout: 10_000, interval: 100 });
    const [row] = await usageRows(world);
    expect(row.walletId).toBe(world.walletId);
    const charged = -(row.appliedCents ?? 0);
    expect(charged).toBeGreaterThan(0);
    expect(await walletCents(world)).toBe(FUNDED_CENTS - charged);
    expect(await liveHolds(world)).toEqual([]);
  });
});

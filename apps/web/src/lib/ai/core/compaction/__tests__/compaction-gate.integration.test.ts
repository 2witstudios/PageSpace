/**
 * Context compaction against a real Postgres (Spec SPEND-1): a compaction is a model call of
 * its own, so it is gated and reserved on its turn's spend target before the model runs and
 * settles exactly once — and a refusal leaves the conversation exactly as it was.
 *
 * apps/web loads @pagespace/lib from its built dist, whose ORGS_ENABLED is the shipped
 * constant (false), so a drive target resolves to the caller's personal root here: this suite
 * proves the path production runs today. The drive-wallet and automation targets are the
 * gate's own (packages/lib wallet-gate / automation-spend integration suites); the compaction
 * unit suite proves runCompaction hands the gate its turn's target unchanged.
 *
 * REAL: the credit gate (canConsumeAI), holds, settlement (AIMonitoring.trackUsage →
 * consumeCredits), the compaction state store, the conversation and its messages.
 * Faked: the model and its provider.
 *
 * Requires DATABASE_URL → a migrated Postgres. Deletes every row it creates.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { asc, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives, pages } from '@pagespace/db/schema/core';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { conversationCompactions } from '@pagespace/db/schema/ai-compaction';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { conversationSpend } from '@pagespace/lib/billing/spend-target';
import type { CompactionMessage, CompactionPlan } from '@pagespace/lib/ai/context-window';
import { ensureTestDb } from '@/test/ensure-test-db';

const { mockGenerateText } = vi.hoisted(() => ({ mockGenerateText: vi.fn() }));

vi.mock('ai', () => ({ generateText: mockGenerateText }));
vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn(async () => ({ model: {}, provider: 'anthropic', modelName: 'claude-3-haiku-20240307' })),
  isProviderError: (p: unknown) => typeof p === 'object' && p !== null && 'error' in p,
}));

import { runCompaction } from '../compaction-service';
import { prepareConversationContext } from '../prepare-context';

const MODEL = 'claude-3-haiku-20240307';
const FUNDED_CENTS = 5_000;

interface World {
  userId: string;
  driveId: string;
  pageId: string;
  conversationId: string;
  walletId: string;
  messageIds: string[];
}

let world: World | null = null;
const originalMode = process.env.DEPLOYMENT_MODE;

/** A person with a page conversation of four messages and a personal root holding `cents`. */
async function build(cents: number): Promise<World> {
  const user = await factories.createUser({ name: 'Ada', subscriptionTier: 'pro' });
  const drive = await factories.createDrive(user.id, { name: 'Notes', slug: `notes-${createId()}` });
  const page = await factories.createPage(drive.id, { type: 'AI_CHAT', title: 'Agent' });
  const conversationId = createId();
  const messageIds: string[] = [];
  const t0 = Date.now() - 60_000;
  for (const [i, role] of (['user', 'assistant', 'user', 'assistant'] as const).entries()) {
    const m = await factories.createChatMessage(page.id, {
      conversationId,
      role,
      userId: role === 'user' ? user.id : null,
      content: `${role} turn ${i}: ${'lorem ipsum '.repeat(20)}`,
      createdAt: new Date(t0 + i * 1000),
    });
    messageIds.push(m.id);
  }
  const [wallet] = await db.insert(wallets).values({
    userId: user.id,
    monthlyRemainingCents: cents,
    monthlyAllowanceCents: cents,
    monthlyPeriodStart: new Date(),
    monthlyPeriodEnd: new Date(Date.now() + 20 * 86_400_000),
  }).returning();
  return { userId: user.id, driveId: drive.id, pageId: page.id, conversationId, walletId: wallet.id, messageIds };
}

async function teardown(w: World): Promise<void> {
  await db.delete(conversationCompactions).where(eq(conversationCompactions.conversationId, w.conversationId));
  await db.delete(creditHolds).where(eq(creditHolds.userId, w.userId));
  await db.delete(creditLedger).where(eq(creditLedger.userId, w.userId));
  await db.delete(aiUsageLogs).where(eq(aiUsageLogs.userId, w.userId));
  await db.delete(messages).where(eq(messages.conversationId, w.conversationId));
  await db.delete(conversations).where(eq(conversations.id, w.conversationId));
  await db.delete(wallets).where(eq(wallets.userId, w.userId));
  await db.delete(pages).where(eq(pages.id, w.pageId));
  await db.delete(drives).where(eq(drives.id, w.driveId));
  await db.delete(users).where(inArray(users.id, [w.userId]));
}

/** The conversation as a turn loads it: every message, oldest first. */
async function history(w: World): Promise<CompactionMessage[]> {
  const rows = await db.select().from(messages).where(eq(messages.conversationId, w.conversationId)).orderBy(asc(messages.createdAt));
  return rows.map((r) => ({ id: r.id, role: r.role as 'user' | 'assistant', parts: [{ type: 'text', text: r.content }], createdAt: r.createdAt }));
}

async function planFor(w: World): Promise<CompactionPlan> {
  const loaded = await history(w);
  const cut = loaded.slice(0, 2);
  return {
    reason: 'over-soft-threshold',
    cutBeforeIndex: 2,
    estimatedTailTokens: 100,
    messagesToSummarize: cut,
    compactedUpToMessageId: cut[1].id ?? null,
    compactedUpToCreatedAt: cut[1].createdAt ?? null,
    currentSummaryVersion: null,
    previousSummary: null,
  };
}

const paramsFor = async (w: World) => ({
  conversationId: w.conversationId,
  source: 'page' as const,
  pageId: w.pageId,
  userId: w.userId,
  provider: 'anthropic',
  model: MODEL,
  plan: await planFor(w),
  spend: conversationSpend(w.driveId, w.conversationId),
});

const walletCents = async (w: World) => (await db.select().from(wallets).where(eq(wallets.id, w.walletId)))[0].monthlyRemainingCents;
const usageRows = async (w: World) => (await db.select().from(creditLedger).where(eq(creditLedger.userId, w.userId))).filter((r) => r.entryType === 'usage');
const liveHolds = (w: World) => db.select().from(creditHolds).where(eq(creditHolds.userId, w.userId));
const compactionRow = async (w: World) => (await db.select().from(conversationCompactions).where(eq(conversationCompactions.conversationId, w.conversationId)))[0];
const usageLogs = (w: World) => db.select().from(aiUsageLogs).where(eq(aiUsageLogs.userId, w.userId));

describe('context compaction is gated and settles once (real Postgres)', () => {
  beforeAll(async () => {
    await ensureTestDb();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEPLOYMENT_MODE = 'cloud';
    mockGenerateText.mockResolvedValue({ text: 'Summary: Ada and the agent discussed lorem ipsum.', usage: { inputTokens: 400_000, outputTokens: 3_000 } });
  });

  afterEach(async () => {
    if (world) await teardown(world);
    world = null;
    process.env.DEPLOYMENT_MODE = originalMode;
  });

  it('SPEND-1 (partial) an exhausted actor\'s compaction calls no model, charges nothing, persists nothing, and the conversation keeps working', async () => {
    world = await build(0);
    const before = await history(world);

    await runCompaction(await paramsFor(world));

    // (a) no model call
    expect(mockGenerateText).not.toHaveBeenCalled();
    // (b) nothing charged, no hold left behind
    expect(await usageRows(world)).toEqual([]);
    expect(await usageLogs(world)).toEqual([]);
    expect(await liveHolds(world)).toEqual([]);
    expect(await walletCents(world)).toBe(0);
    // (c) nothing partial persisted: no summary, no pointer
    expect(await compactionRow(world)).toBeUndefined();
    // The conversation is untouched — every message, including the user's latest, is still
    // there — and the next turn builds its context from the whole history exactly as before.
    const after = await history(world);
    expect(after.map((m) => m.id)).toEqual(world.messageIds);
    expect(after).toEqual(before);
    const next = await prepareConversationContext({
      conversationId: world.conversationId,
      source: 'page',
      pageId: world.pageId,
      messages: after,
      model: MODEL,
      provider: 'anthropic',
      user: { id: world.userId, role: 'user' },
      spend: conversationSpend(world.driveId, world.conversationId),
    });
    expect(next.messages).toEqual(after);
  });

  it('SPEND-1 (partial) a funded actor\'s compaction reserves, runs, settles exactly once on the reserved wallet, and persists the summary', async () => {
    world = await build(FUNDED_CENTS);

    await runCompaction(await paramsFor(world));

    expect(mockGenerateText).toHaveBeenCalledOnce();
    const rows = await usageRows(world);
    expect(rows).toHaveLength(1);
    expect(rows[0].walletId).toBe(world.walletId);
    const charged = -(rows[0].appliedCents ?? 0);
    expect(charged).toBeGreaterThan(0);
    expect(await walletCents(world)).toBe(FUNDED_CENTS - charged);
    const logs = await usageLogs(world);
    expect(logs).toHaveLength(1);
    expect(logs[0].source).toBe('compaction');
    // The hold was settled by that one charge, not left to expire.
    expect(await liveHolds(world)).toEqual([]);
    const row = await compactionRow(world);
    expect(row?.summary).toContain('Summary');
    expect(row?.compactedUpToMessageId).toBe(world.messageIds[1]);
  });

  it('SPEND-1 (partial) a model failure after the reservation charges nothing and releases the hold', async () => {
    world = await build(FUNDED_CENTS);
    mockGenerateText.mockRejectedValue(new Error('provider down'));

    await runCompaction(await paramsFor(world));

    expect(mockGenerateText).toHaveBeenCalledOnce();
    expect(await usageRows(world)).toEqual([]);
    expect(await walletCents(world)).toBe(FUNDED_CENTS);
    await vi.waitFor(async () => expect(await liveHolds(world as World)).toEqual([]), { timeout: 5_000, interval: 50 });
    expect(await compactionRow(world)).toBeUndefined();
  });
});

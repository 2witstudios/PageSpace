/**
 * The memory cron's credit gate, against a REAL Postgres.
 *
 * The cron runs model calls for users who never touch the product that night.
 * Each call reserves the user's own credits first (reserveMemoryCall) and settles
 * that one hold once (AIMonitoring.trackUsage). Overspend becomes debtCents, and
 * the gate is what stops a user in debt from spending more — so a model call the
 * gate never sees accrues debt without bound.
 *
 * Only the model is stubbed (no provider is ever reached); the route, the
 * candidate store, the gate, the holds and the credit ledger are all real.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';

const { generateObjectMock, generateTextMock } = vi.hoisted(() => ({
  generateObjectMock: vi.fn(),
  generateTextMock: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateObject: generateObjectMock,
  generateText: generateTextMock,
}));

vi.mock('@/lib/ai/core/provider-factory', () => ({
  createAIProvider: vi.fn(async () => ({
    model: {},
    provider: 'anthropic',
    modelName: 'anthropic/claude-sonnet-5',
  })),
  isProviderError: (r: unknown) => typeof r === 'object' && r !== null && 'error' in r,
}));

// Page writes snapshot content to object storage (the pre-write snapshot and the
// version history), which this environment has no credentials for. Only those two
// storage calls are stubbed; the page row, its revision and every credit table stay
// real. The version row is skipped with its upload: nothing here reads history.
vi.mock('@pagespace/lib/services/page-version-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-version-service')>()),
  createPageVersion: vi.fn(async () => ({
    id: 'test-version',
    contentRef: 'test-ref',
    contentSize: 0,
    compressed: false,
    storedSize: 0,
    compressionRatio: 1,
  })),
}));
vi.mock('@pagespace/lib/services/page-content-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pagespace/lib/services/page-content-store')>()),
  writePageContent: vi.fn(async (content: string, format: string) => ({
    ref: `${format}:test-${content.length}`,
    size: content.length,
    compressed: false,
    storedSize: content.length,
    compressionRatio: 1,
  })),
}));

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: () => null,
}));

import { db } from '@pagespace/db/db';
import { and, eq, inArray, isNull } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { sessions } from '@pagespace/db/schema/sessions';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { wallets } from '@pagespace/db/schema/wallets';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { personalizationCandidates } from '@pagespace/db/schema/personalization';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { pages } from '@pagespace/db/schema/core';
import { provisionMemoryPages } from '@pagespace/lib/memory/memory-pages';
import { upsertCandidates } from '@/lib/memory/candidate-service';
import { checkAndCompactIfNeeded } from '@/lib/memory/compaction-service';
import { POST } from '../route';

let dbAvailable = false;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The cron processes EVERY active pro user in the database, with a 1s pause
 * between users. On a shared or reused test database that is an unbounded
 * number of pauses, so the pause is collapsed to 0ms, each test gets an
 * explicit timeout, and every row this file creates is deleted after each test.
 */
const TEST_TIMEOUT_MS = 30_000;
const CRON_USER_DELAY_MS = 1000;
const createdUserIds: string[] = [];
let setTimeoutSpy: MockInstance<typeof setTimeout> | undefined;

// 100k in / 10k out on claude-sonnet-5 ($2 / $10 per M) ≈ $0.30 per call before markup.
const USAGE = { inputTokens: 100_000, outputTokens: 10_000 };

async function activeProUser(balance: { monthlyRemainingCents: number; debtCents: number }): Promise<string> {
  const user = await factories.createUser({ subscriptionTier: 'pro' });
  createdUserIds.push(user.id);
  const now = new Date();
  await db.insert(sessions).values({
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    tokenPrefix: 'ps_test',
    userId: user.id,
    type: 'user',
    tokenVersion: 1,
    expiresAt: new Date(now.getTime() + DAY_MS),
    lastUsedAt: now,
  });
  const [conversation] = await db
    .insert(conversations)
    .values({ userId: user.id, type: 'global' })
    .returning();
  await db.insert(messages).values(
    [0, 1, 2, 3].map((i) => ({
      conversationId: conversation.id,
      userId: user.id,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}: always answer in TypeScript`,
      createdAt: new Date(now.getTime() - (i + 1) * 60_000),
    })),
  );
  // A rules candidate corroborated on two earlier days, so the evaluator runs too.
  await upsertCandidates(user.id, [
    { field: 'rules', claim: 'Prefer TypeScript', evidence: 'always TS', occurrencesInWindow: 1, evidenceAt: new Date(now.getTime() - 3 * DAY_MS) },
  ]);
  await upsertCandidates(user.id, [
    { field: 'rules', claim: 'Prefer TypeScript', evidence: 'always TS', occurrencesInWindow: 1, evidenceAt: new Date(now.getTime() - 2 * DAY_MS) },
  ]);
  await db.insert(wallets).values({
    userId: user.id,
    monthlyRemainingCents: balance.monthlyRemainingCents,
    monthlyAllowanceCents: balance.monthlyRemainingCents,
    monthlyPeriodStart: new Date(now.getTime() - DAY_MS),
    topupRemainingCents: 0,
    debtCents: balance.debtCents,
    monthlyPeriodEnd: new Date(now.getTime() + 20 * DAY_MS),
  });
  return user.id;
}

/** A Home drive with the three memory pages, the bio page already over its 3000-char budget. */
async function withOverBudgetBio(userId: string): Promise<string> {
  const home = await factories.createDrive(userId, { kind: 'HOME' });
  const { bioPageId } = await db.transaction((tx) => provisionMemoryPages(userId, home.id, tx));
  await db.update(pages).set({ content: 'x'.repeat(3500) }).where(eq(pages.id, bioPageId));
  return bioPageId;
}

async function pageContent(pageId: string): Promise<string | null> {
  const [page] = await db.select({ content: pages.content }).from(pages).where(eq(pages.id, pageId));
  return page?.content ?? null;
}

async function balanceOf(userId: string) {
  const [row] = await db.select().from(wallets).where(and(eq(wallets.userId, userId), isNull(wallets.subjectType)));
  return row;
}

async function usageRowsOf(userId: string) {
  return db.select().from(aiUsageLogs).where(eq(aiUsageLogs.userId, userId));
}

/**
 * The services debit fire-and-forget (discardUsageOutcome), so the route can
 * return before a charge lands. Wait until every usage row these users have
 * is settled in the ledger — trivially immediate when no model ran.
 */
async function settled(userIds: string[]): Promise<void> {
  await vi.waitFor(async () => {
    const usage = await db.select({ id: aiUsageLogs.id }).from(aiUsageLogs).where(inArray(aiUsageLogs.userId, userIds));
    if (usage.length === 0) return;
    const ledger = await db
      .select({ aiUsageLogId: creditLedger.aiUsageLogId })
      .from(creditLedger)
      .where(and(
        inArray(creditLedger.aiUsageLogId, usage.map((u) => u.id)),
        eq(creditLedger.entryType, 'usage'),
        eq(creditLedger.consumeStatus, 'applied'),
      ));
    expect(ledger).toHaveLength(usage.length);
  }, { timeout: 5000, interval: 50 });
}

describe('memory cron credit gate (Postgres)', () => {
  afterEach(async () => {
    setTimeoutSpy?.mockRestore();
    if (!dbAvailable || createdUserIds.length === 0) return;
    const ids = createdUserIds.splice(0);
    // ai_usage_logs has no FK to users; everything else cascades from the user row.
    await db.delete(aiUsageLogs).where(inArray(aiUsageLogs.userId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  });

  beforeAll(async () => {
    try {
      await db.select().from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('memory/cron credit-gate.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  beforeEach(() => {
    const realSetTimeout = globalThis.setTimeout;
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: () => void, ms?: number) =>
      realSetTimeout(handler, ms === CRON_USER_DELAY_MS ? 0 : ms)) as typeof setTimeout);
    generateObjectMock.mockReset();
    generateTextMock.mockReset();
    generateObjectMock.mockResolvedValue({ object: { claims: [] }, usage: USAGE });
    generateTextMock.mockResolvedValue({ text: '{"usedInsights": []}', usage: USAGE });
  });

  it('a user already in debt: the nightly pass runs no model, charges nothing, and persists nothing', async () => {
    if (!dbAvailable) return;
    const userId = await activeProUser({ monthlyRemainingCents: 0, debtCents: 500 });
    const candidatesBefore = await db.select().from(personalizationCandidates).where(eq(personalizationCandidates.userId, userId));

    const res = await POST(new Request('http://web:3000/api/memory/cron', { method: 'POST' }));
    const body = await res.json();
    await settled([userId]);

    const after = await balanceOf(userId);
    const usage = await usageRowsOf(userId);
    const candidatesAfter = await db.select().from(personalizationCandidates).where(eq(personalizationCandidates.userId, userId));

    expect(res.status).toBe(200);
    expect(body.creditSkipped).toEqual(
      expect.arrayContaining([`${userId}: discovery: out_of_credits`, `${userId}: evaluation: out_of_credits`]),
    );
    expect(usage).toEqual([]);
    expect(after.debtCents).toBe(500);
    expect(after.monthlyRemainingCents).toBe(0);
    // Candidate state lives in promotedAt/rejectedAt: a refused pass must neither
    // settle a candidate nor re-stage one (occurrences, lastSeenAt).
    const snapshot = (rows: typeof candidatesBefore) =>
      rows.map((c) => [c.id, c.promotedAt, c.rejectedAt, c.occurrences, c.lastSeenAt.getTime()]);
    expect(candidatesBefore.length).toBeGreaterThan(0);
    expect(snapshot(candidatesAfter)).toEqual(snapshot(candidatesBefore));
    expect(candidatesAfter.every((c) => c.promotedAt === null && c.rejectedAt === null)).toBe(true);
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, userId))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('a funded user alongside an exhausted one: the funded pass runs and settles each call once', async () => {
    if (!dbAvailable) return;
    const exhausted = await activeProUser({ monthlyRemainingCents: 0, debtCents: 500 });
    const funded = await activeProUser({ monthlyRemainingCents: 10_000, debtCents: 0 });

    const res = await POST(new Request('http://web:3000/api/memory/cron', { method: 'POST' }));
    expect(res.status).toBe(200);
    await settled([exhausted, funded]);

    const fundedUsage = await usageRowsOf(funded);
    // Three discovery passes plus the evaluator.
    expect(fundedUsage).toHaveLength(4);
    const ledger = await db
      .select()
      .from(creditLedger)
      .where(and(inArray(creditLedger.aiUsageLogId, fundedUsage.map((u) => u.id)), eq(creditLedger.entryType, 'usage')));
    expect(ledger).toHaveLength(4);
    expect(ledger.every((l) => l.consumeStatus === 'applied')).toBe(true);
    const fundedAfter = await balanceOf(funded);
    const charged = 10_000 - fundedAfter.monthlyRemainingCents;
    expect(charged).toBe(-ledger.reduce((sum, l) => sum + l.amountCents, 0));
    expect(charged).toBeGreaterThan(0);
    expect(fundedAfter.debtCents).toBe(0);
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, funded))).toEqual([]);

    expect(await usageRowsOf(exhausted)).toEqual([]);
    expect((await balanceOf(exhausted)).debtCents).toBe(500);
  }, TEST_TIMEOUT_MS);

  it('a funded user with an over-budget page: compaction reserves per call and each call settles once', async () => {
    if (!dbAvailable) return;
    const funded = await activeProUser({ monthlyRemainingCents: 10_000, debtCents: 0 });
    const bioPageId = await withOverBudgetBio(funded);
    generateTextMock.mockImplementation(async ({ system }: { system: string }) =>
      system.includes('compacting')
        ? { text: 'A short bio.', usage: USAGE }
        : { text: '{"rules": "Prefer TypeScript.", "usedInsights": [0]}', usage: USAGE },
    );

    const res = await POST(new Request('http://web:3000/api/memory/cron', { method: 'POST' }));
    const body = await res.json();
    await settled([funded]);

    const usage = await usageRowsOf(funded);
    // Three discovery passes, the evaluator, and one compaction.
    expect(usage.map((u) => (u.metadata as { feature: string }).feature).sort()).toEqual([
      'memory_compaction', 'memory_discovery', 'memory_discovery', 'memory_discovery', 'memory_integration',
    ]);
    const ledger = await db
      .select()
      .from(creditLedger)
      .where(and(inArray(creditLedger.aiUsageLogId, usage.map((u) => u.id)), eq(creditLedger.entryType, 'usage')));
    expect(ledger).toHaveLength(5);
    expect(new Set(ledger.map((l) => l.aiUsageLogId)).size).toBe(5);
    const after = await balanceOf(funded);
    expect(10_000 - after.monthlyRemainingCents).toBe(-ledger.reduce((sum, l) => sum + l.amountCents, 0));
    expect(await pageContent(bioPageId)).toBe('A short bio.');
    expect(body.creditSkipped).toBeUndefined();
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, funded))).toEqual([]);
  }, TEST_TIMEOUT_MS);

  it('a user in debt with an over-budget page: compaction runs no model, charges nothing, and leaves the page as it was', async () => {
    if (!dbAvailable) return;
    const userId = await activeProUser({ monthlyRemainingCents: 0, debtCents: 500 });
    const bioPageId = await withOverBudgetBio(userId);

    const result = await checkAndCompactIfNeeded(userId);
    await settled([userId]);

    expect(result).toEqual({ compacted: false, fields: [], creditRefusal: 'out_of_credits' });
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(await usageRowsOf(userId)).toEqual([]);
    expect((await balanceOf(userId)).debtCents).toBe(500);
    expect(await pageContent(bioPageId)).toBe('x'.repeat(3500));
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, userId))).toEqual([]);
  }, TEST_TIMEOUT_MS);
});

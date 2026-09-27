/**
 * The memory cron's credit gate, against a REAL Postgres.
 *
 * The cron runs model calls for users who never touch the product that night,
 * and each call debits AFTER the fact (AIMonitoring.trackUsage → consumeCredits).
 * Overspend becomes debtCents, and the gate is what stops a user in debt from
 * spending more — so a model call the gate never sees accrues debt without bound.
 *
 * Only the model is stubbed (no provider is ever reached); the route, the
 * candidate store, the gate, the holds and the credit ledger are all real.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
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

vi.mock('@/lib/auth/cron-auth', () => ({
  validateSignedCronRequest: () => null,
}));

import { db } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { sessions } from '@pagespace/db/schema/sessions';
import { conversations, messages } from '@pagespace/db/schema/conversations';
import { creditBalances, creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { personalizationCandidates } from '@pagespace/db/schema/personalization';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { upsertCandidates } from '@/lib/memory/candidate-service';
import { POST } from '../route';

let dbAvailable = false;
const DAY_MS = 24 * 60 * 60 * 1000;

// 100k in / 10k out on claude-sonnet-5 ($2 / $10 per M) ≈ $0.30 per call before markup.
const USAGE = { inputTokens: 100_000, outputTokens: 10_000 };

async function activeProUser(balance: { monthlyRemainingCents: number; debtCents: number }): Promise<string> {
  const user = await factories.createUser({ subscriptionTier: 'pro' });
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
  await db.insert(creditBalances).values({
    userId: user.id,
    monthlyRemainingCents: balance.monthlyRemainingCents,
    topupRemainingCents: 0,
    debtCents: balance.debtCents,
    monthlyPeriodEnd: new Date(now.getTime() + 20 * DAY_MS),
  });
  return user.id;
}

async function balanceOf(userId: string) {
  const [row] = await db.select().from(creditBalances).where(eq(creditBalances.userId, userId));
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
  beforeAll(async () => {
    try {
      await db.select().from(creditBalances).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('memory/cron credit-gate.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  beforeEach(() => {
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
    console.info('[repro] exhausted user', {
      status: res.status,
      modelCalls: generateObjectMock.mock.calls.length + generateTextMock.mock.calls.length,
      debtBefore: 500,
      debtAfter: after.debtCents,
      usageRows: usage.length,
      body,
    });

    expect(res.status).toBe(200);
    expect(usage).toEqual([]);
    expect(after.debtCents).toBe(500);
    expect(after.monthlyRemainingCents).toBe(0);
    expect(candidatesAfter.map((c) => [c.id, c.status, c.occurrences])).toEqual(
      candidatesBefore.map((c) => [c.id, c.status, c.occurrences]),
    );
    expect(await db.select().from(creditHolds).where(eq(creditHolds.userId, userId))).toEqual([]);
  });

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
  });
});

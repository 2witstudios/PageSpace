/**
 * The period reset sweep is the ONLY reset of a comped personal root (ew9v06jeb, D-OW-12), against
 * a real Postgres: the credit gate never rolls a period any more; the hourly sweep rolls a comped
 * paid account (no renewal-capable subscription) exactly once per period, on its UTC renewal date,
 * before it resets the child allocations that period governs — so a child sees the new period in
 * the same run and is reset once, never twice.
 *
 * Requires DATABASE_URL → a migrated Postgres; fails loudly without one (requireDb).
 * Deletes every row it creates, children before parents, users last, and ends the pool.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { db, pool } from '@pagespace/db/db';
import { and, eq, inArray } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { drives } from '@pagespace/db/schema/core';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { wallets } from '@pagespace/db/schema/wallets';
import { factories } from '@pagespace/db/test/factories';
import { requireDb } from '@pagespace/db/test/require-db';
import { canConsumeAI } from '../credit-gate';
import { tierAllowanceCents } from '../money-model';
import { PERSONAL_SPEND } from '../spend-target';
import { resetDuePeriods } from '../wallet-funding-shell';

let dbAvailable = false;
const originalMode = process.env.DEPLOYMENT_MODE;
const originalTz = process.env.TZ;
const userIds: string[] = [];

const DAY = 86_400_000;

async function person(tier: 'free' | 'pro' | 'business'): Promise<string> {
  const user = await factories.createUser({ name: `Comped ${tier}`, subscriptionTier: tier });
  userIds.push(user.id);
  return user.id;
}

/** A personal root whose period [start, end) is stored, with what is left of its allowance. */
async function root(userId: string, input: { remainingCents: number; start: Date | null; end: Date | null; debtCents?: number }) {
  const [row] = await db.insert(wallets).values({
    userId,
    monthlyRemainingCents: input.remainingCents,
    monthlyAllowanceCents: tierAllowanceCents('pro'),
    debtCents: input.debtCents ?? 0,
    monthlyPeriodStart: input.start,
    monthlyPeriodEnd: input.end,
  }).returning();
  return row.id;
}

async function liveSubscription(userId: string): Promise<void> {
  await db.insert(subscriptions).values({
    userId,
    stripeSubscriptionId: `sub_${createId()}`,
    stripePriceId: 'price_pro',
    status: 'active',
    currentPeriodStart: new Date(Date.now() - 40 * DAY),
    currentPeriodEnd: new Date(Date.now() - DAY),
  });
}

const rootOf = async (userId: string) => (await db.select().from(wallets).where(and(eq(wallets.userId, userId), eq(wallets.ownerType, 'user'))).orderBy(wallets.createdAt))[0];
const walletRow = async (id: string) => (await db.select().from(wallets).where(eq(wallets.id, id)))[0];
const grantsOf = async (userId: string) =>
  (await db.select().from(creditLedger).where(and(eq(creditLedger.userId, userId), eq(creditLedger.entryType, 'monthly_grant'))));

describe('the comped personal root roll lives in the period sweep, never in the gate (real Postgres)', () => {
  beforeAll(async () => {
    try {
      await db.select({ id: wallets.id }).from(wallets).limit(1);
      dbAvailable = true;
    } catch (error) {
      requireDb('personal-root-roll.integration.test.ts', error);
      dbAvailable = false;
    }
  });

  beforeEach(() => {
    process.env.DEPLOYMENT_MODE = 'cloud';
  });

  afterEach(async () => {
    if (originalMode === undefined) delete process.env.DEPLOYMENT_MODE;
    else process.env.DEPLOYMENT_MODE = originalMode;
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
    if (userIds.length === 0) return;
    const ids = userIds.splice(0);
    await db.delete(creditHolds).where(inArray(creditHolds.userId, ids));
    await db.delete(creditLedger).where(inArray(creditLedger.userId, ids));
    await db.delete(subscriptions).where(inArray(subscriptions.userId, ids));
    // Child wallets before their parent root (parentWalletId has no cascade), then the roots.
    const roots = await db.select({ id: wallets.id }).from(wallets).where(inArray(wallets.userId, ids));
    if (roots.length > 0) await db.delete(wallets).where(inArray(wallets.parentWalletId, roots.map((r) => r.id)));
    await db.delete(wallets).where(inArray(wallets.userId, ids));
    await db.delete(drives).where(inArray(drives.ownerId, ids));
    await db.delete(users).where(inArray(users.id, ids));
  });

  afterAll(async () => {
    await pool.end();
  });

  it('the gate never rolls an expired comped period: it spends what is there, refuses at zero, and writes no grant', async () => {
    if (!dbAvailable) return;
    const userId = await person('pro');
    const end = new Date(Date.now() - DAY);
    await root(userId, { remainingCents: 0, start: new Date(end.getTime() - 30 * DAY), end });

    expect(await canConsumeAI(userId, 'pro', { spend: PERSONAL_SPEND })).toEqual({ allowed: false, reason: 'out_of_credits' });

    const after = await rootOf(userId);
    expect(after.monthlyRemainingCents).toBe(0);
    expect(after.monthlyPeriodEnd!.getTime()).toBe(end.getTime());
    expect(await grantsOf(userId)).toEqual([]);
  });

  it('the sweep rolls a comped account ONCE onto the period starting exactly at its stored end, nets its debt, and the gate then admits', async () => {
    if (!dbAvailable) return;
    const userId = await person('pro');
    const end = new Date(Date.now() - 3 * 3_600_000);
    await root(userId, { remainingCents: 120, debtCents: 20, start: new Date(end.getTime() - 30 * DAY), end });
    const allowance = tierAllowanceCents('pro');

    const first = await resetDuePeriods({ now: new Date() });
    const second = await resetDuePeriods({ now: new Date() });

    expect(first.roots.reset).toBeGreaterThanOrEqual(1);
    expect(second.roots.reset).toBe(0);
    const after = await rootOf(userId);
    // The renewal date does not drift by the sweep's lateness: the period starts at the old end.
    expect(after.monthlyPeriodStart!.getTime()).toBe(end.getTime());
    expect(after.monthlyPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
    expect(after.monthlyRemainingCents).toBe(120 - 20 + allowance);
    expect(after.debtCents).toBe(0);
    const grants = await grantsOf(userId);
    expect(grants.map((g) => [g.amountCents, g.stripeRef])).toEqual([[allowance, `root-roll-${userId}-${end.toISOString()}`]]);
    expect(await canConsumeAI(userId, 'pro', { spend: PERSONAL_SPEND })).toMatchObject({ allowed: true });
  });

  it('three SIMULTANEOUS sweeps roll a period once: one grant, one allowance', async () => {
    if (!dbAvailable) return;
    const userId = await person('business');
    const end = new Date(Date.now() - DAY);
    await root(userId, { remainingCents: 0, start: new Date(end.getTime() - 30 * DAY), end });

    await Promise.all([0, 1, 2].map(() => resetDuePeriods({ now: new Date() })));

    expect(await grantsOf(userId)).toHaveLength(1);
    expect((await rootOf(userId)).monthlyRemainingCents).toBe(tierAllowanceCents('business'));
  });

  it('review P3-3: on onprem and tenant (billing off) the sweep rolls nothing and writes no grant', async () => {
    if (!dbAvailable) return;
    for (const mode of ['onprem', 'tenant'] as const) {
      process.env.DEPLOYMENT_MODE = mode;
      const userId = await person('pro');
      const end = new Date(Date.now() - DAY);
      await root(userId, { remainingCents: 0, start: new Date(end.getTime() - 30 * DAY), end });

      const result = await resetDuePeriods({ now: new Date() });

      expect(result.roots, mode).toEqual({ scanned: 0, reset: 0, failed: 0 });
      const after = await rootOf(userId);
      expect(after.monthlyRemainingCents, mode).toBe(0);
      expect(after.monthlyPeriodEnd!.getTime(), mode).toBe(end.getTime());
      expect(await grantsOf(userId), mode).toEqual([]);
    }
  });

  it('the period is the UTC calendar month even when the process runs in another time zone', async () => {
    if (!dbAvailable) return;
    // 00:30 UTC on 1 Oct is still 30 Sep in Chicago: a local-time month add would end the new period on
    // 31 Oct 00:30 UTC instead of 1 Nov.
    process.env.TZ = 'America/Chicago';
    const userId = await person('pro');
    const end = new Date('2026-10-01T00:30:00.000Z');
    await root(userId, { remainingCents: 0, start: new Date('2026-09-01T00:30:00.000Z'), end });

    await resetDuePeriods({ now: new Date('2026-10-01T01:15:00.000Z') });

    const after = await rootOf(userId);
    expect(after.monthlyPeriodStart!.toISOString()).toBe('2026-10-01T00:30:00.000Z');
    expect(after.monthlyPeriodEnd!.toISOString()).toBe('2026-11-01T00:30:00.000Z');
  });

  it('never rolls an account whose renewal belongs to invoice.paid, or a Free account (one-time grant)', async () => {
    if (!dbAvailable) return;
    const subscribed = await person('pro');
    await liveSubscription(subscribed);
    const free = await person('free');
    const end = new Date(Date.now() - DAY);
    for (const userId of [subscribed, free]) await root(userId, { remainingCents: 0, start: new Date(end.getTime() - 30 * DAY), end });

    await resetDuePeriods({ now: new Date() });

    for (const userId of [subscribed, free]) {
      const after = await rootOf(userId);
      expect(after.monthlyRemainingCents).toBe(0);
      expect(after.monthlyPeriodEnd!.getTime()).toBe(end.getTime());
      expect(await grantsOf(userId)).toEqual([]);
    }
  });

  it('a personal drive allocation under a comped root resets in the SAME run, onto the root\'s new period, exactly once', async () => {
    if (!dbAvailable) return;
    const userId = await person('pro');
    const end = new Date(Date.now() - 2 * 3_600_000);
    const start = new Date(end.getTime() - 30 * DAY);
    const rootId = await root(userId, { remainingCents: 0, start, end });
    const drive = await factories.createDrive(userId, { name: 'Notebook', slug: `notebook-${createId()}` });
    const [child] = await db.insert(wallets).values({
      userId,
      subjectType: 'drive',
      subjectId: drive.id,
      parentWalletId: rootId,
      monthlyAllowanceCents: 1_000,
      spentCents: 700,
      monthlyPeriodStart: start,
      monthlyPeriodEnd: end,
    }).returning();

    const first = await resetDuePeriods({ now: new Date() });
    // A gate call between sweeps resets nothing.
    await canConsumeAI(userId, 'pro', { spend: PERSONAL_SPEND });
    const second = await resetDuePeriods({ now: new Date() });

    expect(first.allocations.reset).toBeGreaterThanOrEqual(1);
    expect(second.allocations.reset).toBe(0);
    const rolledRoot = await walletRow(rootId);
    const resetChild = await walletRow(child.id);
    expect(resetChild.spentCents).toBe(0);
    expect(resetChild.monthlyPeriodStart!.getTime()).toBe(rolledRoot.monthlyPeriodStart!.getTime());
    expect(resetChild.monthlyPeriodEnd!.getTime()).toBe(rolledRoot.monthlyPeriodEnd!.getTime());
    expect(await grantsOf(userId)).toHaveLength(1);
  });
});

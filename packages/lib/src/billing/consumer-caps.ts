/**
 * consumer-caps — the IO behind a person's per-consumer caps on a DRIVE-WALLET leg (Spec WAL-7).
 * The seat leg on the org pool has its own reader (seat-allowance), because a seat's month is the
 * pool period and its overshoot is absorbed per window; a drive wallet's windows are the UTC day
 * and the UTC month, and an overshoot past a cap simply leaves the consumer at or past it.
 *
 * What a cap judges: the consumer's settled spend on THIS wallet in the window (usage plus
 * reconcile corrections, each dated by its call, summed per call and never below zero) plus their
 * live holds on it. The decision itself is wallet-core's `evaluateCaps`.
 *
 * Contract (identical to the seat cap, WAL-2): a cap bounds ADMISSION. A call is admitted
 * against its reservation; its actual cost settles in full on the wallet even when that passes
 * the cap (it cannot be refused after the model ran), the overshoot lands where WAL-6 says —
 * never on the consumer — and every later call in the window is refused source_cap_reached.
 * Page and global chat also bound each stream by what is left (netSpendableCents); v1, /btw,
 * consult and voice have no stream budget, so there one call may pass the cap by its own cost.
 */
import type { db } from '@pagespace/db/db';
import { and, eq, gt, gte, inArray, sql } from '@pagespace/db/operators';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { walletConsumerCaps } from '@pagespace/db/schema/wallets';
import {
  evaluateCaps,
  seatSpentCents,
  userConsumerKey,
  utcDayStartMs,
  utcMonthStartMs,
  type CapRemaining,
  type CapUsage,
  type CapsResult,
  type ConsumerCaps,
} from './wallet-core';

type Reader = Pick<typeof db, 'select'>;

/** A consumer's caps on one leg, or null when none are set (unlimited within the wallet). */
export async function readConsumerCaps(executor: Reader, walletId: string, userId: string): Promise<ConsumerCaps | null> {
  const [row] = await executor
    .select({ dailyCents: walletConsumerCaps.dailyCapCents, monthlyCents: walletConsumerCaps.monthlyCapCents })
    .from(walletConsumerCaps)
    .where(and(eq(walletConsumerCaps.walletId, walletId), eq(walletConsumerCaps.consumerKey, userConsumerKey(userId))))
    .limit(1);
  return row ?? null;
}

/** Settled spend per window, whole cents rounded up, of `userId` on `walletId`. */
export async function consumerSettledCents(
  executor: Reader,
  input: { walletId: string; userId: string; dayStart: Date; monthStart: Date },
): Promise<{ dailyCents: number; monthlyCents: number }> {
  const rowsFrom = new Date(Math.min(input.dayStart.getTime(), input.monthStart.getTime()));
  const callAt = sql`coalesce((SELECT u."createdAt" FROM ${creditLedger} u WHERE u."aiUsageLogId" = ${creditLedger.aiUsageLogId} AND u."entryType" = 'usage' LIMIT 1), ${creditLedger.createdAt})`;
  const calls = executor
    .select({
      at: sql<Date>`min(${callAt})`.as('call_at'),
      millicents: sql<string>`greatest(0, coalesce(sum(${creditLedger.chargeMillicents}), 0))`.as('call_millicents'),
    })
    .from(creditLedger)
    .where(and(
      eq(creditLedger.userId, input.userId),
      eq(creditLedger.walletId, input.walletId),
      inArray(creditLedger.entryType, ['usage', 'adjustment']),
      gte(creditLedger.createdAt, rowsFrom),
    ))
    .groupBy(sql`coalesce(${creditLedger.aiUsageLogId}, ${creditLedger.id})`)
    .as('calls');
  const [sums] = await executor
    .select({
      day: sql<string>`coalesce(sum(${calls.millicents}) FILTER (WHERE ${calls.at} >= ${input.dayStart}), 0)`,
      month: sql<string>`coalesce(sum(${calls.millicents}) FILTER (WHERE ${calls.at} >= ${input.monthStart}), 0)`,
    })
    .from(calls);
  return { dailyCents: seatSpentCents(Number(sums?.day ?? 0)), monthlyCents: seatSpentCents(Number(sums?.month ?? 0)) };
}

export interface ConsumerCapFacts {
  caps: ConsumerCaps;
  usage: CapUsage;
  /** What is left of each window for this consumer (null = no cap in that window). */
  remaining: CapRemaining;
}

/**
 * The caps facts for one person on one drive-wallet leg at `now`, or null when they have no caps
 * there. Run it inside the gate's transaction (under the wallet's row lock) for the decision.
 */
export async function loadConsumerCapFacts(
  executor: Reader,
  input: { walletId: string; userId: string; now: Date },
): Promise<ConsumerCapFacts | null> {
  const caps = await readConsumerCaps(executor, input.walletId, input.userId);
  if (!caps) return null;
  const nowMs = input.now.getTime();
  const dayStart = new Date(utcDayStartMs(nowMs));
  const monthStart = new Date(utcMonthStartMs(nowMs));
  const settled = await consumerSettledCents(executor, { walletId: input.walletId, userId: input.userId, dayStart, monthStart });
  const [held] = await executor
    .select({ cents: sql<string>`coalesce(sum(${creditHolds.estCents}), 0)` })
    .from(creditHolds)
    .where(and(eq(creditHolds.walletId, input.walletId), eq(creditHolds.userId, input.userId), gt(creditHolds.expiresAt, input.now)));
  const reserved = Number(held?.cents ?? 0);
  const usage: CapUsage = {
    dailySpentCents: settled.dailyCents,
    monthlySpentCents: settled.monthlyCents,
    dailyReservedCents: reserved,
    monthlyReservedCents: reserved,
  };
  const zero: CapsResult = evaluateCaps({ caps, usage, reservationCents: 0 });
  return { caps, usage, remaining: { dailyRemainingCents: zero.dailyRemainingCents, monthlyRemainingCents: zero.monthlyRemainingCents } };
}

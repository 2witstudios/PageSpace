/**
 * seat-allowance — the reads behind a seat's monthly cap (Spec WAL-2, D-OW-12).
 *
 * A seat is not a wallet row: it is the org pool, capped per consumer. What one consumer has
 * taken from the pool this period is read from the ledger, the append-only record the money
 * already moves through, so there is no second counter to drift from it:
 *
 *   SUM(credit_ledger.chargeMillicents)
 *     WHERE walletId = the pool AND userId = the consumer
 *       AND entryType IN ('usage', 'adjustment') AND createdAt >= the pool's period start
 *
 * - `usage` rows carry each settled call's full intended charge, including any part that
 *   overshot into pool debt (the pool still pays it). A claimed-but-unsettled row is
 *   already counted, and its hold is deleted only in the settle transaction, so a call is
 *   never missing from both the ledger and the holds.
 * - cost-reconcile `adjustment` rows carry a SIGNED chargeMillicents: an undercharge adds,
 *   an overcharge refund subtracts.
 * - the overshoot `adjustment` row written beside a usage row carries NO chargeMillicents
 *   (its cents are already in the usage row's charge), so the SUM skips it and never counts
 *   the overshoot twice.
 * - grants, top-ups and donations are money INTO wallets, never a consumer's draw.
 *
 * Plus this consumer's live holds on the pool (calls in flight), counted like spend.
 *
 * The period is the pool's own (monthlyPeriodStart, stamped by each refill, D-OW-12), never
 * the consumer's renewal. The gate calls this inside its transaction, holding the pool's row
 * lock, so two calls by one consumer serialize and the second sees the first one's hold.
 */

import type { db } from '@pagespace/db/db';
import { and, eq, gt, gte, inArray, sql } from '@pagespace/db/operators';
import { creditHolds, creditLedger } from '@pagespace/db/schema/credits';
import { walletConsumerCaps } from '@pagespace/db/schema/wallets';
import { seatAllowanceCents, seatPeriodStartMs, userConsumerKey, utcDayStartMs, type SeatUsage } from './wallet-core';

type Reader = Pick<typeof db, 'select'>;

export interface SeatCapFacts {
  /** This consumer's monthly seat allowance on the pool, whole cents (never unlimited). */
  capCents: number;
  /**
   * Their daily cap on the pool leg when one is set (wallet_consumer_caps.dailyCapCents);
   * null = no daily limit (WAL-7: unset is unlimited within the leg). No default is applied:
   * D20.5's 10-credit day is below one call's reservation and would refuse every seat call.
   */
  dailyCapCents: number | null;
  usage: SeatUsage;
}

export async function loadSeatCapFacts(
  executor: Reader,
  input: {
    poolId: string;
    /** The pool's monthlyPeriodStart: the date its last refill started (D-OW-12). */
    poolPeriodStart: Date | null;
    userId: string;
    /** The org's seat allowance (POL-7); null falls to the default. */
    policySeatAllowanceCents: number | null;
    now: Date;
  },
): Promise<SeatCapFacts> {
  const periodStart = new Date(seatPeriodStartMs({ poolPeriodStartMs: input.poolPeriodStart?.getTime() ?? null, nowMs: input.now.getTime() }));
  const [cap] = await executor
    .select({ monthlyCapCents: walletConsumerCaps.monthlyCapCents, dailyCapCents: walletConsumerCaps.dailyCapCents })
    .from(walletConsumerCaps)
    .where(and(eq(walletConsumerCaps.walletId, input.poolId), eq(walletConsumerCaps.consumerKey, userConsumerKey(input.userId))))
    .limit(1);
  // The day window never reaches back before the period: a refill mid-day starts both afresh.
  const dayStart = new Date(Math.max(periodStart.getTime(), utcDayStartMs(input.now.getTime())));
  const [charged] = await executor
    .select({
      millicents: sql<string>`coalesce(sum(${creditLedger.chargeMillicents}), 0)`,
      dayMillicents: sql<string>`coalesce(sum(${creditLedger.chargeMillicents}) FILTER (WHERE ${creditLedger.createdAt} >= ${dayStart}), 0)`,
    })
    .from(creditLedger)
    .where(and(
      eq(creditLedger.userId, input.userId),
      eq(creditLedger.walletId, input.poolId),
      inArray(creditLedger.entryType, ['usage', 'adjustment']),
      gte(creditLedger.createdAt, periodStart),
    ));
  const [held] = await executor
    .select({ cents: sql<string>`coalesce(sum(${creditHolds.estCents}), 0)` })
    .from(creditHolds)
    .where(and(
      eq(creditHolds.userId, input.userId),
      eq(creditHolds.walletId, input.poolId),
      gt(creditHolds.expiresAt, input.now),
    ));
  return {
    capCents: seatAllowanceCents({
      consumerMonthlyCapCents: cap?.monthlyCapCents ?? null,
      policySeatAllowanceCents: input.policySeatAllowanceCents,
    }),
    dailyCapCents: cap?.dailyCapCents ?? null,
    usage: {
      periodChargedMillicents: Number(charged?.millicents ?? 0),
      periodReservedCents: Number(held?.cents ?? 0),
      dayChargedMillicents: Number(charged?.dayMillicents ?? 0),
    },
  };
}

/**
 * seat-allowance — the reads behind a seat's monthly cap (Spec WAL-2, D-OW-12).
 *
 * A seat is not a wallet row: it is the org pool, capped per consumer. What one consumer has
 * taken from the pool this period is read from the ledger, the append-only record the money
 * already moves through, so there is no second counter to drift from it:
 *
 *   SUM over calls of max(0, SUM(credit_ledger.chargeMillicents))   -- gross, per window
 *     WHERE walletId = the pool AND userId = the consumer AND spendKind IN ('ai', 'compute', 'drive_compute')
 *       AND entryType IN ('usage', 'adjustment')
 *     grouped by call (aiUsageLogId), each call dated by its usage row
 *   judged against the cap in force now
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
 * - a seat-overshoot row (written at settle and at reconcile, under the pool lock) records a
 *   SIGNED change to what one window's cap absorbed: the pool paid the spend past the cap
 *   (WAL-6b/c). These rows are the attribution record (the consumer's count is min(gross,
 *   cap), the rest is the pool's); the caps never read them, so no stale or wrong row can
 *   widen admission.
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
import { creditHolds, creditLedger, type SpendKind } from '@pagespace/db/schema/credits';
import { walletConsumerCaps } from '@pagespace/db/schema/wallets';
import { seatAllowanceCents, seatCountedMillicents, seatPeriodStartMs, userConsumerKey, utcDayStartMs, type SeatUsage, type SeatWindowCharge } from './wallet-core';

type Reader = Pick<typeof db, 'select'>;

/**
 * The spend a seat counts: everything a member draws on the pool (WAL-2), under one cap —
 *   - their AI calls ('ai');
 *   - the compute THEY ran ('compute': sandbox runtime, the terminal, browsers, their session's
 *     storage), recorded under the person who caused it (review #2760 P1);
 *   - the accruals of the environments and published apps they CREATED ('drive_compute': env/app
 *     storage, wakes and awake time), recorded under the env's cost owner — the creator, or the
 *     drive lead for an env with none (pre-D-OW-28, or its creator left the org) ([D-OW-28]).
 * So compute cannot reopen the pool drain the seat cap closed for AI (fe9db1nm). Every kind
 * counts: what differs between them is only WHO a row is recorded under, which the writer decides.
 */
export const SEAT_COUNTED_SPEND_KINDS: readonly SpendKind[] = ['ai', 'compute', 'drive_compute'];

/** Whether a charge of `spendKind` on an org pool is a member's seat draw. */
export function isSeatCountedSpendKind(spendKind: SpendKind): boolean {
  return SEAT_COUNTED_SPEND_KINDS.includes(spendKind);
}

/** The ledger entries for a seat's spend past one cap, absorbed by the pool: one per cap window. */
export const SEAT_OVERSHOOT_ENTRY = { month: 'seat_overshoot_month', day: 'seat_overshoot_day' } as const;

export interface SeatCapFacts {
  /** This consumer's monthly seat allowance on the pool, whole cents (never unlimited). */
  capCents: number;
  /**
   * Their daily cap on the pool leg when one is set (wallet_consumer_caps.dailyCapCents);
   * null = no daily limit (WAL-7: unset is unlimited within the leg). No default is applied:
   * D20.5's 10-credit day is below one call's reservation and would refuse every seat call.
   */
  dailyCapCents: number | null;
  /** Settled spend net of each window's own absorbed overshoot, plus holds: what the caps judge. */
  usage: SeatUsage;
  /** Each window's gross settled spend and what the pool absorbed of it (the settle-side facts). */
  windows: { period: SeatWindowCharge; day: SeatWindowCharge };
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
  // The day is the UTC day, whatever the period (WAL-7: daily caps are UTC). A refill lands at
  // any time of day and restarts only the PERIOD; spend earlier the same UTC day still counts
  // against the daily cap, so a refill never grants a second daily allowance (point-guard
  // ruling on review P2-1, IRV-R7). The rows read reach back to whichever window starts first.
  const dayStart = new Date(utcDayStartMs(input.now.getTime()));
  const rowsFrom = new Date(Math.min(periodStart.getTime(), dayStart.getTime()));
  // Every seat charge counts in the window of the CALL it belongs to: a reconcile correction
  // is dated by the call's usage row, not by when the cron ran, so a refund for yesterday's
  // (or last period's) call never opens room today. And each call nets to at least zero, so no
  // correction, however large, can push a window below what was really spent in it.
  // (Review 5340856661 P2-1: IRV-C1, IRV-C2.) A correction's own row is never older than its
  // call's, so filtering the rows themselves from the earlier window start loses nothing.
  const callAt = sql`coalesce((SELECT u."createdAt" FROM ${creditLedger} u WHERE u."aiUsageLogId" = ${creditLedger.aiUsageLogId} AND u."entryType" = 'usage' LIMIT 1), ${creditLedger.createdAt})`;
  const calls = executor
    .select({
      at: sql<Date>`min(${callAt})`.as('call_at'),
      millicents: sql<string>`greatest(0, coalesce(sum(${creditLedger.chargeMillicents}), 0))`.as('call_millicents'),
    })
    .from(creditLedger)
    .where(and(
      eq(creditLedger.userId, input.userId),
      eq(creditLedger.walletId, input.poolId),
      inArray(creditLedger.entryType, ['usage', 'adjustment']),
      // Every kind is a seat draw for the person the row is recorded under — see SEAT_COUNTED_SPEND_KINDS.
      inArray(creditLedger.spendKind, [...SEAT_COUNTED_SPEND_KINDS]),
      gte(creditLedger.createdAt, rowsFrom),
    ))
    .groupBy(sql`coalesce(${creditLedger.aiUsageLogId}, ${creditLedger.id})`)
    .as('calls');
  const [gross] = await executor
    .select({
      period: sql<string>`coalesce(sum(${calls.millicents}) FILTER (WHERE ${calls.at} >= ${periodStart}), 0)`,
      day: sql<string>`coalesce(sum(${calls.millicents}) FILTER (WHERE ${calls.at} >= ${dayStart}), 0)`,
    })
    .from(calls);
  // What the pool absorbed per window: attribution records only. The caps never read them
  // (see below), so a stale or wrong one can never widen admission.
  const inDay = sql`${creditLedger.createdAt} >= ${dayStart}`;
  const [absorbed] = await executor
    .select({
      period: sql<string>`coalesce(sum(${creditLedger.chargeMillicents}) FILTER (WHERE ${creditLedger.entryType} = ${SEAT_OVERSHOOT_ENTRY.month} AND ${creditLedger.createdAt} >= ${periodStart}), 0)`,
      day: sql<string>`coalesce(sum(${creditLedger.chargeMillicents}) FILTER (WHERE ${creditLedger.entryType} = ${SEAT_OVERSHOOT_ENTRY.day} AND ${inDay}), 0)`,
    })
    .from(creditLedger)
    .where(and(
      eq(creditLedger.userId, input.userId),
      eq(creditLedger.walletId, input.poolId),
      inArray(creditLedger.entryType, [SEAT_OVERSHOOT_ENTRY.month, SEAT_OVERSHOOT_ENTRY.day]),
      gte(creditLedger.createdAt, rowsFrom),
    ));
  const [held] = await executor
    .select({ cents: sql<string>`coalesce(sum(${creditHolds.estCents}), 0)` })
    .from(creditHolds)
    .where(and(
      eq(creditHolds.userId, input.userId),
      eq(creditHolds.walletId, input.poolId),
      // A hold in flight is a seat draw too, whatever it reserves for — see SEAT_COUNTED_SPEND_KINDS.
      inArray(creditHolds.spendKind, [...SEAT_COUNTED_SPEND_KINDS]),
      gt(creditHolds.expiresAt, input.now),
    ));
  const period = { grossMillicents: Number(gross?.period ?? 0), absorbedMillicents: Number(absorbed?.period ?? 0) };
  const day = { grossMillicents: Number(gross?.day ?? 0), absorbedMillicents: Number(absorbed?.day ?? 0) };
  const capCents = seatAllowanceCents({
    consumerMonthlyCapCents: cap?.monthlyCapCents ?? null,
    policySeatAllowanceCents: input.policySeatAllowanceCents,
  });
  const dailyCapCents = cap?.dailyCapCents ?? null;
  return {
    capCents,
    dailyCapCents,
    // The caps judge GROSS against the cap in force NOW, shown as min(gross, cap): the same
    // decision as gross (both refuse at gross >= cap), and never computed from a stored
    // absorbed figure, so raising or lowering a cap takes effect at once (review 5340856661
    // P2-2, IRV-C3). A cap lowered below what is spent reads as full: no room, never negative.
    usage: {
      periodChargedMillicents: seatCountedMillicents({ capCents, grossMillicents: period.grossMillicents }),
      periodReservedCents: Number(held?.cents ?? 0),
      dayChargedMillicents: seatCountedMillicents({ capCents: dailyCapCents, grossMillicents: day.grossMillicents }),
    },
    windows: { period, day },
  };
}

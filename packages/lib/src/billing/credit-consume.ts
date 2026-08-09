/**
 * credit-consume — imperative shell that debits a user's prepaid balance for one
 * AI call. Pure decisions (markup, monthly-first split) come from credit-core;
 * this file only does I/O.
 *
 * Correctness:
 *   - Idempotent: a unique index on credit_ledger.aiUsageLogId means each AI call
 *     is billed at most once. The claim insert uses onConflictDoNothing; a
 *     conflict short-circuits the decrement.
 *   - Atomic: the balance read+write is a single transaction with a row lock, so
 *     concurrent calls by the same user can't lose an update.
 *   - Safe: never throws into the AI request. A failed decrement leaves the
 *     ledger row 'pending' for the backfill cron (settlePendingLedgerRow); a
 *     failed claim leaves no row, and the cron's orphan sweep reconciles it.
 */

import { db } from '@pagespace/db/db';
import { creditBalances, creditLedger, creditHolds } from '@pagespace/db/schema/credits';
import { eq, sql } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { chargeMillicents, accruePending, allocateSpend } from './credit-core';
import { MARKUP_BPS } from './credit-pricing';
import { emitCreditsUpdated } from './credit-emit';
import { loggers } from '../logging/logger-config';

export interface ConsumeCreditsInput {
  aiUsageLogId: string;
  userId: string;
  costDollars: number;
  /**
   * The reservation placed by the gate for this call, released here at settle.
   * Live requests thread it through from canConsumeAI; the reconcile cron's
   * orphan/retry paths pass none (the hold, if any, is reclaimed by expiry).
   */
  holdId?: string;
  /**
   * Optional scope so the live `credits:updated` push can carry conversation/page
   * hints (the per-conversation usage monitor filters on them). Live chat routes
   * thread these through; background jobs and the reconcile cron leave them unset,
   * so the navbar still updates while the per-conversation view is untouched.
   */
  conversationId?: string;
  pageId?: string;
  /**
   * Per-call override for the markup applied at settle, in basis points.
   * Absent for every ordinary AI-model call (they get the shared global
   * {@link MARKUP_BPS}); terminal/Machine billing passes `MACHINE_MARKUP_BPS`
   * here so its 1.5× substrate floor holds independent of AI markup changes.
   */
  markupBpsOverride?: number;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Within a transaction: lock the balance row, fold this call's sub-cent charge into
 * the per-user remainder, draw the resulting whole cents down monthly-first via the
 * pure core, and persist the result. Three correctness guarantees beyond the naive
 * version:
 *   - Sub-cent (R3): the charge arrives in MILLICENTS; `accruePending` banks the
 *     fraction so cheap calls accumulate instead of rounding to $0.
 *   - Actual decrement (R2b): we record `appliedCents` = what truly left the balance,
 *     not the intended charge, so the ledger reconciles against the balance delta.
 *   - Debt (R2b): when the balance can't cover the charge, the uncovered remainder is
 *     BOTH raised on `debtCents` (the live materialized debt — so the net balance,
 *     monthly + topup − debt, goes negative and the gate blocks further AI) AND written
 *     as an 'adjustment' ledger row (the per-overage incurrence history). The buckets
 *     themselves stay >= 0; the negative lives in `debtCents`, which a purchase pays
 *     down or is netted against carry at the next renewal.
 * If no balance row exists yet, the ledger row is left untouched ('pending') so the
 * reconcile cron settles it once a balance is created. Shared by consumeCredits and
 * settlePendingLedgerRow.
 */
async function decrementAndSettle(
  tx: Tx,
  ledgerId: string,
  userId: string,
  chargeMc: number,
  aiUsageLogId: string | null,
  holdId: string | null = null,
): Promise<void> {
  const rows = await tx
    .select()
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .for('update');
  const bal = rows[0] as
    | {
        monthlyRemainingCents: number;
        topupRemainingCents: number;
        pendingMillicents: number;
        monthlyPeriodEnd: Date | null;
      }
    | undefined;

  // No balance row yet (e.g. an existing user before the gate lazy-inits one).
  // Leave the ledger row 'pending' so the reconcile cron retries once a balance
  // exists — never mark a call 'applied' without decrementing it, which would
  // silently drop the charge and hide it from both backfill sweeps.
  if (!bal) return;

  // Rollover: the carry balance is always spendable, even after the monthly period
  // ends. The gate no longer zeroes expired paid monthly, and settle must match:
  // allocateSpend draws monthly-first, so if we excluded the monthly here a call
  // approved via carry credits would draw from top-up instead, misattributing the
  // spend bucket. The renewal invoice.paid adds the new allowance on top of whatever
  // remains at the time it fires, so spending during the gap is correctly accounted.
  const spendableMonthly = bal.monthlyRemainingCents;

  // Fold the sub-cent charge into the carried remainder, then spend the whole cents.
  const accrual = accruePending(bal.pendingMillicents ?? 0, chargeMc);
  const spend = allocateSpend(
    { monthlyCents: spendableMonthly, topupCents: bal.topupRemainingCents },
    accrual.wholeCents,
  );

  await tx
    .update(creditBalances)
    .set({
      monthlyRemainingCents: spend.monthlyCents,
      topupRemainingCents: spend.topupCents,
      pendingMillicents: accrual.newPending,
      // Uncovered cost becomes debt: the net balance (monthly + topup − debt) goes
      // negative and the gate blocks further AI until it's paid down by a purchase or
      // netted against carry at the next renewal. Buckets still floor at 0 (above); debt carries
      // the overage. No-op when the call was fully covered (shortfallCents === 0).
      ...(spend.shortfallCents > 0
        ? { debtCents: sql`${creditBalances.debtCents} + ${spend.shortfallCents}` }
        : {}),
    })
    .where(eq(creditBalances.userId, userId));

  await tx
    .update(creditLedger)
    .set({
      consumeStatus: 'applied',
      bucket: spend.spentTopup > spend.spentMonthly ? 'topup' : 'monthly',
      // What actually came out of the balance (signed, matching the usage row's
      // negative convention). The gap between this and the intended charge is the
      // shortfall, recorded as a debt row below. `|| 0` avoids storing -0 when a
      // sub-cent call accrues into pending without decrementing a whole cent.
      appliedCents: -spend.appliedCents || 0,
    })
    .where(eq(creditLedger.id, ledgerId));

  // Uncovered remainder -> persist as debt rather than discard it. Same txn, so the
  // books reconcile atomically: balance floored at 0, the overage owed and queryable
  // by aiUsageLogId. consumeStatus is terminal ('applied') so the backfill cron's
  // pending sweep never mistakes this debt row for an unsettled decrement to retry.
  if (spend.shortfallCents > 0) {
    await tx.insert(creditLedger).values({
      userId,
      entryType: 'adjustment',
      bucket: 'monthly',
      amountCents: -spend.shortfallCents,
      aiUsageLogId,
      consumeStatus: 'applied',
    });
  }

  // Release the gate's reservation in the SAME transaction as the decrement: once
  // this call's real cost has left the balance, its hold no longer reserves spend
  // and must not keep shrinking spendable or counting against the in-flight cap.
  // Idempotent — a missing/expired hold (already swept) deletes zero rows.
  if (holdId) {
    await tx.delete(creditHolds).where(eq(creditHolds.id, holdId));
  }
}

export async function consumeCredits(input: ConsumeCreditsInput): Promise<void> {
  if (!isBillingEnabled()) return; // tenant/onprem are unlimited

  // Guard a malformed cost before it can produce a bogus ledger claim. A
  // non-finite or negative cost is a programming/upstream error, not a billable
  // event — skip it rather than persist a garbage row. (cost 0 is valid: free
  // models bill nothing.)
  if (!Number.isFinite(input.costDollars) || input.costDollars < 0) {
    loggers.ai.debug('credit consume skipped: invalid cost', {
      costDollars: input.costDollars,
      aiUsageLogId: input.aiUsageLogId,
    });
    return;
  }

  // The precise charge in millicents (sub-cent accurate). The whole-cent `amountCents`
  // on the claim row is the per-call nominal charge for audit; the authoritative
  // sub-cent value is `chargeMillicents`, which settlement and any retry replay.
  const markupBps = input.markupBpsOverride ?? MARKUP_BPS;
  const chargeMc = chargeMillicents(input.costDollars, markupBps);
  const nominalCents = Math.round(chargeMc / 1000);
  // Signed (negative) for the usage row; `|| 0` avoids storing -0 for a sub-cent charge.
  const amountCents = -nominalCents || 0;
  const realCostCents = Math.max(0, Math.round(input.costDollars * 100));

  // 1. Idempotent claim — one usage ledger row per aiUsageLogId.
  let ledgerId: string;
  try {
    const claimed = await db
      .insert(creditLedger)
      .values({
        userId: input.userId,
        entryType: 'usage',
        bucket: 'monthly',
        amountCents,
        chargeMillicents: chargeMc,
        aiUsageLogId: input.aiUsageLogId,
        realCostCents,
        markupBps,
        consumeStatus: 'pending',
      })
      // The unique index on aiUsageLogId is partial (WHERE aiUsageLogId IS NOT NULL
      // AND entryType = 'usage'); Postgres can only infer it as the conflict arbiter
      // if we restate that predicate. Scoping to 'usage' lets a debt 'adjustment' row
      // share the same aiUsageLogId without tripping the usage-decrement uniqueness.
      .onConflictDoNothing({
        target: creditLedger.aiUsageLogId,
        where: sql`${creditLedger.aiUsageLogId} IS NOT NULL AND ${creditLedger.entryType} = 'usage'`,
      })
      .returning({ id: creditLedger.id });
    if (claimed.length === 0) return; // already consumed — idempotent no-op
    ledgerId = claimed[0].id;
  } catch (error) {
    // No ledger row persisted; the cron's orphan sweep will reconcile.
    loggers.ai.debug('credit claim failed', {
      error: (error as Error).message,
      aiUsageLogId: input.aiUsageLogId,
    });
    return;
  }

  // A zero-charge call (free/local model, or a tool-only analytics log carrying
  // no tokens) has nothing to draw down — not even a sub-cent fraction to carry.
  // Settle the claimed row as 'skipped' without opening the balance transaction —
  // no row lock, no $0 decrement. The claim row still exists, so the reconcile
  // cron's orphan sweep treats this call as already handled and never re-processes
  // it. NOTE: a sub-cent call has chargeMc > 0 and is NOT skipped here — it goes
  // through the transaction so its fraction accrues into pendingMillicents.
  if (chargeMc === 0) {
    try {
      await db
        .update(creditLedger)
        .set({ consumeStatus: 'skipped' })
        .where(eq(creditLedger.id, ledgerId));
      // A zero-charge call still placed a hold at the gate (the gate runs before the
      // real cost is known). Release it so it doesn't reserve phantom spend or keep
      // counting against the in-flight cap until it expires.
      if (input.holdId) {
        await db.delete(creditHolds).where(eq(creditHolds.id, input.holdId));
        // Releasing the hold frees the user's spendable — push the fresh balance.
        void emitCreditsUpdated(input.userId, {
          conversationId: input.conversationId,
          pageId: input.pageId,
        });
      }
    } catch (error) {
      loggers.ai.debug('credit zero-charge settle failed', {
        error: (error as Error).message,
        aiUsageLogId: input.aiUsageLogId,
      });
    }
    return;
  }

  // 2. Decrement the balance and settle the ledger row, atomically.
  try {
    await db.transaction((tx) =>
      decrementAndSettle(tx, ledgerId, input.userId, chargeMc, input.aiUsageLogId, input.holdId ?? null),
    );
    // The debit + hold release committed: push the user's fresh balance so the navbar
    // reflects this call's spend live (no refresh). Best-effort, never blocks the call.
    void emitCreditsUpdated(input.userId, {
      conversationId: input.conversationId,
      pageId: input.pageId,
    });
  } catch (error) {
    // Leave the row 'pending' for the backfill cron to retry. Never throw.
    loggers.ai.debug('credit consume failed', {
      error: (error as Error).message,
      aiUsageLogId: input.aiUsageLogId,
    });
  }
}

/**
 * Release a gate reservation without billing. Used when a request placed a hold
 * but produced no billable usage — e.g. a pre-generation failure (0 tokens) that
 * never reaches consumeCredits — so the reservation isn't left to linger against
 * the user's spendable / in-flight cap until the reconcile cron expires it.
 * Deletes in EVERY deployment mode: billing-off deployments reserve holds too
 * (the daily-ceiling path in canConsumeAI), and those must not linger either.
 * Idempotent and never throws: a missing/expired hold deletes zero rows.
 */
export async function releaseHold(holdId: string): Promise<void> {
  try {
    // Return the hold's owner so we can push their freed balance. A missing/expired
    // hold deletes zero rows and yields no userId — then there's nothing to emit.
    const deleted = await db
      .delete(creditHolds)
      .where(eq(creditHolds.id, holdId))
      .returning({ userId: creditHolds.userId });
    const userId = deleted[0]?.userId;
    // The credits push is a billing-UI concern — skip it when billing is off.
    if (userId && isBillingEnabled()) void emitCreditsUpdated(userId);
  } catch (error) {
    loggers.ai.debug('credit hold release failed', { error: (error as Error).message, holdId });
  }
}

/**
 * Re-apply a ledger row that was claimed but never settled (consumeCredits
 * crashed/failed after the claim). Reads the row's stored amount, then decrements
 * atomically. A no-op if the row is missing or already applied — safe to retry.
 */
export async function settlePendingLedgerRow(ledgerId: string): Promise<void> {
  let settledUserId: string | null = null;
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.id, ledgerId))
      .for('update');
    const row = rows[0] as
      | {
          userId: string;
          amountCents: number;
          chargeMillicents: number | null;
          aiUsageLogId: string | null;
          consumeStatus: string;
        }
      | undefined;
    if (!row || row.consumeStatus !== 'pending') return;
    // Replay the precise sub-cent charge. Pre-migration rows have no millicents
    // stored; fall back to the whole-cent intended charge (loses <1 cent of
    // precision on those legacy rows only).
    const chargeMc = row.chargeMillicents ?? Math.abs(row.amountCents) * 1000;
    await decrementAndSettle(tx, ledgerId, row.userId, chargeMc, row.aiUsageLogId);
    settledUserId = row.userId;
  });
  // A pending row settled this run (cron retry): push the user's fresh balance so a
  // call that never emitted at its own finish still reaches the navbar live.
  if (settledUserId) void emitCreditsUpdated(settledUserId);
}

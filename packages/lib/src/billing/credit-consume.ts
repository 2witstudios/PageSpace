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
import { creditBalances, creditLedger } from '@pagespace/db/schema/credits';
import { eq, sql } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { markupCents, allocateSpend } from './credit-core';
import { MARKUP_BPS } from './credit-pricing';
import { loggers } from '../logging/logger-config';

export interface ConsumeCreditsInput {
  aiUsageLogId: string;
  userId: string;
  costDollars: number;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Within a transaction: lock the balance row, draw down monthly-first via the
 * pure core, persist the new balance, and mark the ledger row applied. If no
 * balance row exists yet, the ledger row is left untouched ('pending') so the
 * reconcile cron settles it once a balance is created. Shared by consumeCredits
 * and settlePendingLedgerRow.
 */
async function decrementAndSettle(
  tx: Tx,
  ledgerId: string,
  userId: string,
  amountCents: number,
): Promise<void> {
  const rows = await tx
    .select()
    .from(creditBalances)
    .where(eq(creditBalances.userId, userId))
    .for('update');
  const bal = rows[0] as { monthlyRemainingCents: number; topupRemainingCents: number } | undefined;

  // No balance row yet (e.g. an existing user before the gate lazy-inits one).
  // Leave the ledger row 'pending' so the reconcile cron retries once a balance
  // exists — never mark a call 'applied' without decrementing it, which would
  // silently drop the charge and hide it from both backfill sweeps.
  if (!bal) return;

  const spend = allocateSpend(
    { monthlyCents: bal.monthlyRemainingCents, topupCents: bal.topupRemainingCents },
    amountCents,
  );

  await tx
    .update(creditBalances)
    .set({ monthlyRemainingCents: spend.monthlyCents, topupRemainingCents: spend.topupCents })
    .where(eq(creditBalances.userId, userId));

  await tx
    .update(creditLedger)
    .set({
      consumeStatus: 'applied',
      bucket: spend.spentTopup > spend.spentMonthly ? 'topup' : 'monthly',
    })
    .where(eq(creditLedger.id, ledgerId));
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

  const amountCents = markupCents(input.costDollars, MARKUP_BPS);
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
        amountCents: -amountCents,
        aiUsageLogId: input.aiUsageLogId,
        realCostCents,
        markupBps: MARKUP_BPS,
        consumeStatus: 'pending',
      })
      // The unique index on aiUsageLogId is partial (WHERE aiUsageLogId IS NOT NULL);
      // Postgres can only infer it as the conflict arbiter if we restate that predicate.
      .onConflictDoNothing({
        target: creditLedger.aiUsageLogId,
        where: sql`${creditLedger.aiUsageLogId} IS NOT NULL`,
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
  // no tokens) has nothing to draw down. Settle the claimed row as 'skipped'
  // without opening the balance transaction — no row lock, no $0 decrement. The
  // claim row still exists, so the reconcile cron's orphan sweep treats this call
  // as already handled and never re-processes it.
  if (amountCents === 0) {
    try {
      await db
        .update(creditLedger)
        .set({ consumeStatus: 'skipped' })
        .where(eq(creditLedger.id, ledgerId));
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
    await db.transaction((tx) => decrementAndSettle(tx, ledgerId, input.userId, amountCents));
  } catch (error) {
    // Leave the row 'pending' for the backfill cron to retry. Never throw.
    loggers.ai.debug('credit consume failed', {
      error: (error as Error).message,
      aiUsageLogId: input.aiUsageLogId,
    });
  }
}

/**
 * Re-apply a ledger row that was claimed but never settled (consumeCredits
 * crashed/failed after the claim). Reads the row's stored amount, then decrements
 * atomically. A no-op if the row is missing or already applied — safe to retry.
 */
export async function settlePendingLedgerRow(ledgerId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.id, ledgerId))
      .for('update');
    const row = rows[0] as { userId: string; amountCents: number; consumeStatus: string } | undefined;
    if (!row || row.consumeStatus !== 'pending') return;
    await decrementAndSettle(tx, ledgerId, row.userId, Math.abs(row.amountCents));
  });
}

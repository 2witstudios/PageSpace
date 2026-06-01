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
 *     ledger row 'pending' for the backfill cron; a failed claim leaves no row,
 *     and the cron's orphan sweep reconciles it.
 */

import { db } from '@pagespace/db/db';
import { creditBalances, creditLedger } from '@pagespace/db/schema/credits';
import { eq } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { markupCents, allocateSpend } from './credit-core';
import { MARKUP_BPS } from './credit-pricing';
import { loggers } from '../logging/logger-config';

export interface ConsumeCreditsInput {
  aiUsageLogId: string;
  userId: string;
  costDollars: number;
}

export async function consumeCredits(input: ConsumeCreditsInput): Promise<void> {
  if (!isBillingEnabled()) return; // tenant/onprem are unlimited

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
      .onConflictDoNothing({ target: creditLedger.aiUsageLogId })
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

  // 2. Decrement the balance and settle the ledger row, atomically.
  try {
    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(creditBalances)
        .where(eq(creditBalances.userId, input.userId))
        .for('update');
      const bal = rows[0] as { monthlyRemainingCents: number; topupRemainingCents: number } | undefined;

      const spend = allocateSpend(
        { monthlyCents: bal?.monthlyRemainingCents ?? 0, topupCents: bal?.topupRemainingCents ?? 0 },
        amountCents,
      );

      if (bal) {
        await tx
          .update(creditBalances)
          .set({ monthlyRemainingCents: spend.monthlyCents, topupRemainingCents: spend.topupCents })
          .where(eq(creditBalances.userId, input.userId));
      }

      await tx
        .update(creditLedger)
        .set({
          consumeStatus: 'applied',
          bucket: spend.spentTopup > spend.spentMonthly ? 'topup' : 'monthly',
        })
        .where(eq(creditLedger.id, ledgerId));
    });
  } catch (error) {
    // Leave the row 'pending' for the backfill cron to retry. Never throw.
    loggers.ai.debug('credit consume failed', {
      error: (error as Error).message,
      aiUsageLogId: input.aiUsageLogId,
    });
  }
}

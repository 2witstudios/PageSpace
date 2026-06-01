/**
 * credit-backfill — reconciliation shell run by a cron. Guarantees every billable
 * AI call decrements the prepaid balance exactly once, even across crashes and
 * mid-flight deploys. Two sweeps, planned by the pure computeBackfillActions:
 *   1. ledger rows stuck 'pending' (claimed but never settled) -> re-settle
 *   2. usage rows with no ledger entry at all (consume never ran) -> consume now
 * Local-only: makes NO Stripe calls.
 */

import { db } from '@pagespace/db/db';
import { creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { and, eq, lt, isNull, isNotNull } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { computeBackfillActions } from './credit-core';
import { consumeCredits, settlePendingLedgerRow } from './credit-consume';
import { loggers } from '../logging/logger-config';

const BATCH = 200;
const GRACE_MS = 5 * 60 * 1000; // let an in-flight consume finish before sweeping

export interface BackfillResult {
  retried: number;
  orphans: number;
}

export async function backfillCredits(): Promise<BackfillResult> {
  if (!isBillingEnabled()) return { retried: 0, orphans: 0 };

  const cutoff = new Date(Date.now() - GRACE_MS);

  const pending = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.consumeStatus, 'pending'), lt(creditLedger.createdAt, cutoff)))
    .limit(BATCH);

  const orphans = await db
    .select({ aiUsageLogId: aiUsageLogs.id, userId: aiUsageLogs.userId, cost: aiUsageLogs.cost })
    .from(aiUsageLogs)
    .leftJoin(creditLedger, eq(creditLedger.aiUsageLogId, aiUsageLogs.id))
    .where(
      and(
        isNull(creditLedger.id),
        isNotNull(aiUsageLogs.cost),
        eq(aiUsageLogs.success, true),
        lt(aiUsageLogs.timestamp, cutoff),
      ),
    )
    .limit(BATCH);

  const actions = computeBackfillActions(
    pending,
    orphans.map((o) => ({ aiUsageLogId: o.aiUsageLogId, userId: o.userId, costDollars: o.cost ?? 0 })),
  );

  let retried = 0;
  let orphanCount = 0;
  for (const action of actions) {
    try {
      if (action.kind === 'retry_pending') {
        await settlePendingLedgerRow(action.ledgerId);
        retried++;
      } else {
        await consumeCredits({
          aiUsageLogId: action.aiUsageLogId,
          userId: action.userId,
          costDollars: action.costDollars,
        });
        orphanCount++;
      }
    } catch (error) {
      loggers.ai.debug('credit backfill action failed', {
        error: (error as Error).message,
        action,
      });
    }
  }

  return { retried, orphans: orphanCount };
}

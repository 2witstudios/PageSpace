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
import { and, eq, lt, gt, isNull } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { computeBackfillActions } from './credit-core';
import { consumeCredits, settlePendingLedgerRow } from './credit-consume';
import { loggers } from '../logging/logger-config';

const BATCH = 200;
const GRACE_MS = 5 * 60 * 1000; // let an in-flight consume finish before sweeping
// Safety cap on drain passes so a perpetually-stuck row (one that keeps failing
// to settle and so re-appears in every sweep) can't spin the cron unbounded.
// BATCH * MAX_PASSES per sweep is the most one cron run will clear.
const MAX_PASSES = 50;

export interface BackfillResult {
  retried: number;
  orphans: number;
}

export async function backfillCredits(): Promise<BackfillResult> {
  if (!isBillingEnabled()) return { retried: 0, orphans: 0 };

  const cutoff = new Date(Date.now() - GRACE_MS);

  let retried = 0;
  let orphanCount = 0;

  // Drain the backlog: each settled/consumed row drops out of the next sweep
  // (pending rows flip off 'pending'; orphans gain a ledger row), so re-querying
  // makes forward progress. Keep going until a pass returns fewer than BATCH from
  // both sweeps (nothing more to fetch), bounded by MAX_PASSES.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const pending = await db
      .select({ id: creditLedger.id })
      .from(creditLedger)
      .where(and(eq(creditLedger.consumeStatus, 'pending'), lt(creditLedger.createdAt, cutoff)))
      .limit(BATCH);

    // Reconcile usage rows that never decremented the balance — including
    // success:false rows that still carry a non-zero cost (tokens consumed before
    // a mid-stream error: real provider spend that must be billed). Rows with
    // no/zero cost are excluded; there is nothing to draw down for them.
    const orphans = await db
      .select({ aiUsageLogId: aiUsageLogs.id, userId: aiUsageLogs.userId, cost: aiUsageLogs.cost })
      .from(aiUsageLogs)
      .leftJoin(creditLedger, eq(creditLedger.aiUsageLogId, aiUsageLogs.id))
      .where(
        and(
          isNull(creditLedger.id),
          gt(aiUsageLogs.cost, 0),
          lt(aiUsageLogs.timestamp, cutoff),
        ),
      )
      .limit(BATCH);

    if (pending.length === 0 && orphans.length === 0) break;

    const actions = computeBackfillActions(
      pending,
      orphans.map((o) => ({ aiUsageLogId: o.aiUsageLogId, userId: o.userId, costDollars: o.cost ?? 0 })),
    );

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

    // A short pass means both sweeps are drained; stop. A full pass on either
    // sweep means more rows may remain — loop again (up to MAX_PASSES).
    if (pending.length < BATCH && orphans.length < BATCH) break;

    if (pass === MAX_PASSES - 1) {
      loggers.ai.debug('credit backfill hit MAX_PASSES; backlog may remain', {
        retried,
        orphans: orphanCount,
      });
    }
  }

  return { retried, orphans: orphanCount };
}

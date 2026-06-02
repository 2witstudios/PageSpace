/**
 * credit-backfill — reconciliation shell run by a cron. Guarantees every billable
 * AI call decrements the prepaid balance exactly once, even across crashes and
 * mid-flight deploys. Two sweeps, planned by the pure computeBackfillActions:
 *   1. ledger rows stuck 'pending' (claimed but never settled) -> re-settle
 *   2. usage rows with no ledger entry at all (consume never ran) -> consume now
 * Local-only: makes NO Stripe calls.
 */

import { db } from '@pagespace/db/db';
import { creditLedger, creditHolds } from '@pagespace/db/schema/credits';
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
  /** Stale holds reclaimed this run (a crashed stream's reservation never settled). */
  expiredHolds: number;
}

export async function backfillCredits(): Promise<BackfillResult> {
  if (!isBillingEnabled()) return { retried: 0, orphans: 0, expiredHolds: 0 };

  const now = new Date();
  const cutoff = new Date(now.getTime() - GRACE_MS);

  // Sweep abandoned holds FIRST: a hold from a crashed/abandoned stream that never
  // reached consumeCredits would otherwise reserve spend (and count against the
  // free in-flight cap) forever. Deleting them past expiresAt frees that spendable
  // back up. A live, still-running stream's hold has a future expiresAt and is
  // untouched. Idempotent — re-running deletes nothing new.
  let expiredHolds = 0;
  try {
    const swept = await db
      .delete(creditHolds)
      .where(lt(creditHolds.expiresAt, now))
      .returning({ id: creditHolds.id });
    expiredHolds = swept.length;
  } catch (error) {
    loggers.ai.debug('credit hold expiry sweep failed', { error: (error as Error).message });
  }

  let retried = 0;
  let orphanCount = 0;

  // Fingerprint of the rows a pass fetched. If two consecutive passes fetch the
  // exact same set, nothing settled between them and re-running can't make
  // progress — e.g. balance-less 'pending' rows that decrementAndSettle leaves
  // untouched (credit-consume.ts), which would otherwise be re-attempted every
  // pass up to MAX_PASSES. Stop instead of churning the same unprocessable rows.
  let prevFingerprint = '';

  // Drain the backlog: each settled/consumed row drops out of the next sweep
  // (pending rows flip off 'pending'; orphans gain a ledger row), so re-querying
  // makes forward progress. Keep going until a pass returns fewer than BATCH from
  // both sweeps (nothing more to fetch) or stops making progress, bounded by
  // MAX_PASSES.
  let pass = 0;
  for (; pass < MAX_PASSES; pass++) {
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

    // Sorted so the comparison is order-independent (the sweeps have no ORDER BY).
    const fingerprint =
      pending.map((p) => p.id).sort().join(',') +
      '|' +
      orphans.map((o) => o.aiUsageLogId).sort().join(',');
    if (fingerprint === prevFingerprint) break; // no forward progress — give up this run
    prevFingerprint = fingerprint;
  }

  // Loop ran to the cap rather than draining/stalling — a real backlog remains.
  if (pass === MAX_PASSES) {
    loggers.ai.debug('credit backfill hit MAX_PASSES; backlog may remain', {
      retried,
      orphans: orphanCount,
    });
  }

  return { retried, orphans: orphanCount, expiredHolds };
}

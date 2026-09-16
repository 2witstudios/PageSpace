/**
 * missed-grant-reconcile — the Phase 2 reconcile cron picks up 'missed_grant' rows
 * (Spec MON-2, WAL-5; follow-up from ow-a3's D-OW-16 fail-closed path).
 *
 * A paid invoice whose tier resolved to one with no ratio (a stale stored tier, or
 * an invoice-derived tier the webhook could not resolve) writes a 'missed_grant'
 * ledger row instead of guessing: amountCents 0, paidCents = what was actually
 * paid, stripeRef = the invoice. This module re-resolves the tier from the LIVE
 * subscription at reconcile time, grants amount_paid × ratio exactly once if a
 * ratio now exists, and marks the row consumed by converting it in place into the
 * 'monthly_grant' it should always have been. A row whose tier still has no ratio
 * is left untouched for the next sweep — never dropped, never double-granted
 * (converting entryType out of 'missed_grant' is what removes it from the next
 * sweep's SELECT, so a crash between the read and the write just re-attempts it).
 */

import { db } from '@pagespace/db/db';
import { creditBalances, creditLedger } from '@pagespace/db/schema/credits';
import { users } from '@pagespace/db/schema/auth';
import { eq } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { computeMonthlyRefill } from './credit-core';
import { allowanceCentsForPaidCents } from './money-model';
import { toSubscriptionTier, type SubscriptionTier } from './subscription-tiers';
import { emitCreditsUpdated } from './credit-emit';
import { loggers } from '../logging/logger-config';

const BATCH = 200;

export interface MissedGrantReconcileResult {
  /** Rows converted into a real monthly_grant this run. */
  reconciled: number;
  /** Rows whose re-resolved tier still has no ratio — left for a later sweep. */
  stillMissing: number;
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

export interface MissedGrantRow {
  id: string;
  userId: string;
  /** What the original invoice paid — the amount the derived grant is sized from. */
  paidCents: number;
}

export interface MissedGrantPlan {
  id: string;
  userId: string;
  tier: SubscriptionTier;
  allowanceCents: number;
  /** 'grant' converts the row now; 'still_missing' leaves it for a later sweep. */
  action: 'grant' | 'still_missing';
}

/**
 * MON-2: re-derive the grant from the row's paidCents and the tier resolved NOW
 * (never the stale tier that caused the miss). `allowanceCentsForPaidCents` is the
 * same pure function every other grant path uses — one definition, no drift.
 */
export function planMissedGrantReconcile(row: MissedGrantRow, resolvedTier: string): MissedGrantPlan {
  const tier = toSubscriptionTier(resolvedTier);
  const allowanceCents = allowanceCentsForPaidCents(row.paidCents, tier);
  return {
    id: row.id,
    userId: row.userId,
    tier,
    allowanceCents,
    action: allowanceCents > 0 ? 'grant' : 'still_missing',
  };
}

// ---------------------------------------------------------------------------
// Imperative shell
// ---------------------------------------------------------------------------

/**
 * Sweep 'missed_grant' ledger rows, re-resolve each user's live tier, and convert
 * any row whose tier now has a ratio into the monthly_grant it should have been —
 * added to the current balance (rollover), same arithmetic as a normal renewal.
 * The row itself becomes the grant record: entryType flips to 'monthly_grant' and
 * amountCents becomes the derived allowance, so a re-run of this sweep never sees
 * it again (WAL-5: reconciliation is keyed on the ledger, not a side table).
 */
export async function reconcileMissedGrants(): Promise<MissedGrantReconcileResult> {
  if (!isBillingEnabled()) return { reconciled: 0, stillMissing: 0 };

  const rows = await db
    .select({ id: creditLedger.id, userId: creditLedger.userId, paidCents: creditLedger.paidCents })
    .from(creditLedger)
    .where(eq(creditLedger.entryType, 'missed_grant'))
    .limit(BATCH);

  let reconciled = 0;
  let stillMissing = 0;
  const toEmit = new Set<string>();

  for (const row of rows) {
    try {
      const userRows = await db
        .select({ subscriptionTier: users.subscriptionTier })
        .from(users)
        .where(eq(users.id, row.userId))
        .limit(1);
      if (!userRows.length) {
        // The user no longer exists (account deleted since the miss): nothing to
        // reconcile it against. Leave the row — it is inert, not actionable.
        stillMissing++;
        continue;
      }

      const plan = planMissedGrantReconcile(
        { id: row.id, userId: row.userId, paidCents: row.paidCents ?? 0 },
        userRows[0].subscriptionTier,
      );

      if (plan.action === 'still_missing') {
        stillMissing++;
        continue;
      }

      await db.transaction(async (tx) => {
        // Convert the row in place: it stops being a 'missed_grant' the moment
        // this commits, which is what removes it from the next sweep's SELECT —
        // the update IS the "mark consumed" step, not a separate flag.
        const updated = await tx
          .update(creditLedger)
          .set({ entryType: 'monthly_grant', amountCents: plan.allowanceCents })
          .where(eq(creditLedger.id, row.id))
          .returning({ id: creditLedger.id });
        // A concurrent reconcile run (or the row having already been converted)
        // updated 0 rows: another pass already handled it. Do not double-grant.
        if (updated.length === 0) return;

        await tx
          .insert(creditBalances)
          .values({ userId: row.userId })
          .onConflictDoNothing({ target: creditBalances.userId });

        const [balanceRow] = await tx
          .select({ monthlyRemainingCents: creditBalances.monthlyRemainingCents, debtCents: creditBalances.debtCents })
          .from(creditBalances)
          .where(eq(creditBalances.userId, row.userId))
          .for('update')
          .limit(1);

        const refill = computeMonthlyRefill(
          plan.allowanceCents,
          balanceRow?.monthlyRemainingCents ?? 0,
          balanceRow?.debtCents ?? 0,
        );

        await tx
          .update(creditBalances)
          .set({
            monthlyRemainingCents: refill.monthlyRemainingCents,
            monthlyAllowanceCents: refill.monthlyAllowanceCents,
            debtCents: refill.debtCents,
          })
          .where(eq(creditBalances.userId, row.userId));
      });

      reconciled++;
      toEmit.add(row.userId);
    } catch (error) {
      loggers.ai.debug('missed-grant reconcile failed for one row', {
        error: (error as Error).message,
        ledgerId: row.id,
      });
    }
  }

  for (const userId of toEmit) void emitCreditsUpdated(userId);

  return { reconciled, stillMissing };
}

/**
 * missed-grant-reconcile — the Phase 2 reconcile cron picks up 'missed_grant' rows
 * (Spec MON-2, WAL-5; follow-up from ow-a3's D-OW-16 fail-closed path).
 *
 * A paid invoice whose tier resolved to one with no ratio (a stale stored tier, or
 * an invoice-derived tier the webhook could not resolve) writes a 'missed_grant'
 * ledger row instead of guessing: amountCents 0, paidCents = what was actually
 * paid, stripeRef = the invoice. This module re-resolves the tier from the user's
 * subscriptions rows at reconcile time (never the users.subscriptionTier cache —
 * a stale cache is the very failure this repairs), grants amount_paid × ratio
 * exactly once if a ratio now exists, and marks the row consumed by converting it
 * in place into the
 * 'monthly_grant' it should always have been. A row whose tier still has no ratio
 * is left untouched for the next sweep — never dropped, never double-granted
 * (converting entryType out of 'missed_grant' is what removes it from the next
 * sweep's SELECT, so a crash between the read and the write just re-attempts it).
 */

import { db } from '@pagespace/db/db';
import { creditBalances, creditLedger } from '@pagespace/db/schema/credits';
import { subscriptions } from '@pagespace/db/schema/subscriptions';
import { and, eq, gt, inArray } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { computeMonthlyRefill } from './credit-core';
import { allowanceCentsForPaidCents } from './money-model';
import { toSubscriptionTier, type SubscriptionTier } from './subscription-tiers';
import { deriveTierFromSubscriptions, type SubscriptionRowLike } from './subscription-tier-sync';
import { emitCreditsUpdated } from './credit-emit';
import { loggers } from '../logging/logger-config';

const BATCH = 200;
/** Cap on ledger ids echoed back for alerting, so a mass event cannot bloat the payload. */
const MAX_INDETERMINATE_IDS = 50;

export interface MissedGrantReconcileResult {
  /** Rows converted into a real monthly_grant this run. */
  reconciled: number;
  /** Rows whose re-resolved tier still has no ratio — left for a later sweep. */
  stillMissing: number;
  /**
   * Rows whose user holds an entitled subscription the price map cannot classify
   * (unmapped price id, and the invoice amount matches no legacy price). Left
   * missing and warned per row: a later sweep cannot resolve these on its own, so
   * they need a human (map the price, or grant by hand).
   */
  indeterminate: number;
  /** Ledger ids of the indeterminate rows (capped), so the cron can alert with them. */
  indeterminateLedgerIds: string[];
  /**
   * Rows whose lookup or grant transaction threw — left as 'missed_grant' for a
   * later sweep, logged at error, and surfaced so the cron can fail loudly.
   */
  failed: number;
}

interface MissedGrantReconcileOptions {
  /**
   * Maps a Stripe price id to its tier; the web app injects getTierFromPrice. When
   * the user has exactly ONE subscription row (any status) the missed invoice must
   * have been billed on it, so its paidCents is passed as the amount and an unmapped
   * legacy price id still resolves through the exact-match legacy amount table (the
   * subscriptions table stores no amount). With more than one row the invoice amount
   * may describe a different subscription, so no amount is passed; an unmapped
   * entitled row then stays indeterminate.
   */
  priceTier: (stripePriceId: string, amountCents: number | null) => SubscriptionTier;
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

type ClaimOutcome = 'granted' | 'already_claimed';

/**
 * Convert one row and roll its allowance into the balance, atomically. The claim
 * UPDATE is guarded on entryType = 'missed_grant', not just the (immutable) id: an
 * overlapping run that SELECTed the same row blocks on this row lock, then
 * re-evaluates the predicate against the committed version and matches nothing —
 * so the balance is only ever touched by the run whose claim affected a row.
 */
async function grantMissedRow(row: { id: string; userId: string }, allowanceCents: number): Promise<ClaimOutcome> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(creditLedger)
      .set({ entryType: 'monthly_grant', amountCents: allowanceCents })
      .where(and(eq(creditLedger.id, row.id), eq(creditLedger.entryType, 'missed_grant')))
      .returning({ id: creditLedger.id });
    if (claimed.length === 0) return 'already_claimed';

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
      allowanceCents,
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

    return 'granted';
  });
}

/**
 * Sweep 'missed_grant' ledger rows, re-derive each user's tier from their
 * subscriptions rows, and convert any row whose tier now has a ratio into the
 * monthly_grant it should have been — added to the current balance (rollover),
 * same arithmetic as a normal renewal. The row itself becomes the grant record:
 * entryType flips to 'monthly_grant' and amountCents becomes the derived
 * allowance, so a re-run of this sweep never sees it again (WAL-5: reconciliation
 * is keyed on the ledger, not a side table).
 *
 * The sweep pages through ALL candidates by keyset on id, so rows that stay
 * unresolved can never monopolize a fixed-size batch and starve later repairable
 * rows. An indeterminate derivation (an entitled subscription on an unmapped
 * price) is left missing rather than granted from a lower-bound tier: converting
 * the row is final, so it must never be sized from a tier we know may be wrong.
 */
export async function reconcileMissedGrants(options: MissedGrantReconcileOptions): Promise<MissedGrantReconcileResult> {
  const result: MissedGrantReconcileResult = {
    reconciled: 0,
    stillMissing: 0,
    indeterminate: 0,
    indeterminateLedgerIds: [],
    failed: 0,
  };
  if (!isBillingEnabled()) return result;

  const toEmit = new Set<string>();
  let cursor = '';

  for (;;) {
    const page = await db
      .select({ id: creditLedger.id, userId: creditLedger.userId, paidCents: creditLedger.paidCents })
      .from(creditLedger)
      .where(and(eq(creditLedger.entryType, 'missed_grant'), gt(creditLedger.id, cursor)))
      .orderBy(creditLedger.id)
      .limit(BATCH);
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    let rowsByUser: Map<string, SubscriptionRowLike[]>;
    try {
      const subRows = await db
        .select({ userId: subscriptions.userId, status: subscriptions.status, stripePriceId: subscriptions.stripePriceId })
        .from(subscriptions)
        .where(inArray(subscriptions.userId, [...new Set(page.map((r) => r.userId))]));
      rowsByUser = new Map();
      for (const sub of subRows) {
        const list = rowsByUser.get(sub.userId) ?? [];
        list.push(sub);
        rowsByUser.set(sub.userId, list);
      }
    } catch (error) {
      result.failed += page.length;
      loggers.api.error('missed-grant reconcile: subscription lookup failed for a page', error as Error, {
        firstLedgerId: page[0].id,
        rows: page.length,
      });
      if (page.length < BATCH) break;
      continue;
    }

    for (const row of page) {
      try {
        const userSubs = rowsByUser.get(row.userId) ?? [];
        const invoiceAmount = userSubs.length === 1 ? row.paidCents : null;
        const derived = deriveTierFromSubscriptions(userSubs, (priceId) => options.priceTier(priceId, invoiceAmount));
        const plan = planMissedGrantReconcile(
          { id: row.id, userId: row.userId, paidCents: row.paidCents ?? 0 },
          derived.tier,
        );
        if (derived.indeterminate) {
          result.indeterminate++;
          if (result.indeterminateLedgerIds.length < MAX_INDETERMINATE_IDS) result.indeterminateLedgerIds.push(row.id);
          loggers.api.warn('missed-grant reconcile: indeterminate tier (entitled subscription on an unmapped price) — needs a human', {
            ledgerId: row.id,
            userId: row.userId,
            paidCents: row.paidCents,
          });
          continue;
        }
        if (plan.action === 'still_missing') {
          result.stillMissing++;
          continue;
        }

        const outcome = await grantMissedRow(row, plan.allowanceCents);
        // 'already_claimed': an overlapping run converted it first — it granted, not us.
        if (outcome === 'granted') {
          result.reconciled++;
          toEmit.add(row.userId);
        }
      } catch (error) {
        result.failed++;
        loggers.api.error('missed-grant reconcile failed for one row', error as Error, {
          ledgerId: row.id,
          userId: row.userId,
        });
      }
    }

    if (page.length < BATCH) break;
  }

  for (const userId of toEmit) void emitCreditsUpdated(userId);

  return result;
}

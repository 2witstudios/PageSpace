/**
 * cost-reconcile — async correction of AI-call billing against OpenRouter's authoritative
 * cost. We bill at stream finish on the cost OpenRouter returns inline, but its
 * `/api/v1/generation?id=` endpoint reports the FINAL reconciled `total_cost` once native
 * cache/discount pricing settles, which can differ. A cron runs this shell: for each
 * OpenRouter usage row still 'pending' reconcile, fetch the authoritative cost for every
 * generation id, compare to what we billed (pure computeCostDrift), and write a correcting
 * 'adjustment' ledger row + balance delta when the drift clears tolerance.
 *
 * Correctness mirrors credit-consume:
 *   - Idempotent: the adjustment row carries a unique reconcileGenerationKey (the sorted
 *     generation ids); onConflictDoNothing makes a re-run / overlapping cron a no-op, and
 *     the balance delta is applied ONLY when the claim row is freshly inserted.
 *   - Atomic: claim + balance update commit in one transaction under a balance row lock.
 *   - Bounded: BATCH/MAX_PASSES like credit-backfill, and each row is fetched at most once
 *     per run (a `seen` set) so a not-yet-resolved generation isn't re-hit in the same run.
 *   - Safe: never throws into the cron; a failed row is left 'pending' for the next run.
 */

import { db } from '@pagespace/db/db';
import { creditBalances, creditLedger } from '@pagespace/db/schema/credits';
import { aiUsageLogs } from '@pagespace/db/schema/monitoring';
import { and, eq, lt, sql } from '@pagespace/db/operators';
import { isBillingEnabled } from '../deployment-mode';
import { computeCostDrift, accruePending, allocateSpend, applyPaymentToDebt } from './credit-core';
import {
  MARKUP_BPS,
  COST_RECONCILE_TOLERANCE_CENTS,
  COST_RECONCILE_TOLERANCE_BPS,
  COST_RECONCILE_MAX_ATTEMPTS,
  openRouterBaseUrl,
} from './credit-pricing';
import { emitCreditsUpdated } from './credit-emit';
import { loggers } from '../logging/logger-config';

const BATCH = 200;
const MAX_PASSES = 50;
// Let the generation settle on OpenRouter's side before we ask for its final cost; a
// freshly-finished call's /generation row may not carry total_cost immediately.
const GRACE_MS = 2 * 60 * 1000;

/** Result of fetching one generation's authoritative cost. */
export type GenerationFetchResult = { totalCost: number } | 'not_found' | 'error';
/** Injectable so tests stub the OpenRouter call and the e2e base-URL override applies. */
export type GenerationFetcher = (id: string) => Promise<GenerationFetchResult>;

export interface CostReconcileResult {
  /** Rows whose authoritative cost resolved and drift was evaluated (corrected or not). */
  fetched: number;
  /** Rows that needed and received a correcting adjustment. */
  corrected: number;
  /** Rows whose generation never resolved within COST_RECONCILE_MAX_ATTEMPTS. */
  unavailable: number;
  /** Rows marked 'skipped' (no generation ids — defensive; shouldn't normally occur). */
  skipped: number;
}

/** Read generationIds out of the aiUsageLogs.metadata jsonb defensively. */
function extractGenerationIds(metadata: unknown): string[] {
  if (typeof metadata !== 'object' || metadata === null) return [];
  const ids = (metadata as Record<string, unknown>).generationIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** Default fetcher: GET {base}/generation?id= with the managed OpenRouter key. */
async function defaultFetcher(id: string): Promise<GenerationFetchResult> {
  const apiKey = process.env.OPENROUTER_DEFAULT_API_KEY;
  if (!apiKey) return 'error';
  try {
    const res = await fetch(`${openRouterBaseUrl()}/generation?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    // 404 = generation not (yet) available; retry on a later run.
    if (res.status === 404) return 'not_found';
    if (!res.ok) return 'error';
    const json = (await res.json()) as { data?: { total_cost?: unknown } };
    const totalCost = json?.data?.total_cost;
    if (typeof totalCost !== 'number' || !Number.isFinite(totalCost)) return 'not_found';
    return { totalCost };
  } catch {
    return 'error';
  }
}

interface PendingRow {
  id: string;
  userId: string;
  cost: number | null;
  metadata: unknown;
  reconcileAttempts: number;
}

async function markStatus(
  aiUsageLogId: string,
  status: 'reconciled' | 'unavailable' | 'skipped',
  now: Date,
): Promise<void> {
  await db
    .update(aiUsageLogs)
    .set({ reconcileStatus: status, reconciledAt: now })
    .where(eq(aiUsageLogs.id, aiUsageLogId));
}

async function bumpAttempts(aiUsageLogId: string): Promise<void> {
  await db
    .update(aiUsageLogs)
    .set({ reconcileAttempts: sql`${aiUsageLogs.reconcileAttempts} + ${1}` })
    .where(eq(aiUsageLogs.id, aiUsageLogId));
}

/**
 * Apply the drift correction in one transaction: claim an adjustment row keyed by the
 * generation set (idempotent), then — only if the claim was fresh — lock the balance and
 * move the signed delta. Positive delta (we undercharged) debits monthly-first and accrues
 * debt on shortfall, mirroring decrementAndSettle; negative delta (we overcharged) refunds
 * debt-first then tops up. Returns true when a balance change was actually applied.
 */
async function applyCorrection(
  userId: string,
  drift: ReturnType<typeof computeCostDrift>,
  aiUsageLogId: string,
  generationIds: string[],
): Promise<boolean> {
  const reconcileKey = [...generationIds].sort().join(',');
  // Signed nominal cents for the adjustment row: positive delta = more spend = negative
  // amount; negative delta = refund = positive amount. `|| 0` avoids storing -0.
  const amountCents = -Math.round(drift.deltaChargeMillicents / 1000) || 0;

  return db.transaction(async (tx) => {
    const claimed = await tx
      .insert(creditLedger)
      .values({
        userId,
        entryType: 'adjustment',
        bucket: 'monthly',
        amountCents,
        chargeMillicents: drift.deltaChargeMillicents,
        realCostCents: drift.deltaRealCostCents,
        aiUsageLogId,
        reconcileGenerationKey: reconcileKey,
        markupBps: MARKUP_BPS,
        consumeStatus: 'applied',
      })
      .onConflictDoNothing({
        target: creditLedger.reconcileGenerationKey,
        where: sql`${creditLedger.reconcileGenerationKey} IS NOT NULL`,
      })
      .returning({ id: creditLedger.id });
    // Already corrected by a prior/overlapping run — do NOT touch the balance again.
    if (claimed.length === 0) return false;
    const ledgerId = claimed[0].id;

    const balRows = await tx
      .select()
      .from(creditBalances)
      .where(eq(creditBalances.userId, userId))
      .for('update');
    const bal = balRows[0] as
      | {
          monthlyRemainingCents: number;
          topupRemainingCents: number;
          pendingMillicents: number;
          debtCents: number;
          monthlyPeriodEnd: Date | null;
        }
      | undefined;
    // No balance row to move (rare — reconcile runs on billed rows). Record the
    // correction row with no applied delta so a later run doesn't re-correct.
    if (!bal) {
      await tx.update(creditLedger).set({ appliedCents: 0 }).where(eq(creditLedger.id, ledgerId));
      return false;
    }

    let appliedCents = 0;
    if (drift.deltaChargeMillicents > 0) {
      // Undercharge → debit the extra, monthly-first, debt on shortfall (matches settle).
      const monthlyExpired = bal.monthlyPeriodEnd != null && bal.monthlyPeriodEnd < new Date();
      const accrual = accruePending(bal.pendingMillicents ?? 0, drift.deltaChargeMillicents);
      const spend = allocateSpend(
        { monthlyCents: monthlyExpired ? 0 : bal.monthlyRemainingCents, topupCents: bal.topupRemainingCents },
        accrual.wholeCents,
      );
      await tx
        .update(creditBalances)
        .set({
          monthlyRemainingCents: spend.monthlyCents,
          topupRemainingCents: spend.topupCents,
          pendingMillicents: accrual.newPending,
          ...(spend.shortfallCents > 0
            ? { debtCents: sql`${creditBalances.debtCents} + ${spend.shortfallCents}` }
            : {}),
        })
        .where(eq(creditBalances.userId, userId));
      appliedCents = -spend.appliedCents || 0; // negative: decremented
    } else if (drift.deltaChargeMillicents < 0) {
      // Overcharge → refund: pay down debt first, remainder to the never-expiring top-up.
      const refundCents = Math.round(Math.abs(drift.deltaChargeMillicents) / 1000);
      const r = applyPaymentToDebt(bal.debtCents ?? 0, bal.topupRemainingCents, refundCents);
      await tx
        .update(creditBalances)
        .set({ debtCents: r.debtCents, topupRemainingCents: r.topupCents })
        .where(eq(creditBalances.userId, userId));
      appliedCents = refundCents; // positive: credited back
    }

    await tx.update(creditLedger).set({ appliedCents }).where(eq(creditLedger.id, ledgerId));
    return true;
  });
}

type RowOutcome = 'corrected' | 'reconciled' | 'unavailable' | 'pending' | 'skipped';

async function reconcileRow(row: PendingRow, fetcher: GenerationFetcher, now: Date): Promise<RowOutcome> {
  const ids = extractGenerationIds(row.metadata);
  if (ids.length === 0) {
    await markStatus(row.id, 'skipped', now);
    return 'skipped';
  }

  let total = 0;
  for (const id of ids) {
    const r = await fetcher(id);
    if (r === 'not_found' || r === 'error') {
      // Not resolved (or transient) — bump attempts and retry on a later run; give up
      // (mark 'unavailable') once we've exhausted the attempt budget.
      if (row.reconcileAttempts + 1 >= COST_RECONCILE_MAX_ATTEMPTS) {
        await markStatus(row.id, 'unavailable', now);
        return 'unavailable';
      }
      await bumpAttempts(row.id);
      return 'pending';
    }
    total += r.totalCost;
  }

  const drift = computeCostDrift(
    {
      billedRealCostCents: Math.round((row.cost ?? 0) * 100),
      authoritativeRealCostDollars: total,
      toleranceCents: COST_RECONCILE_TOLERANCE_CENTS,
      toleranceBps: COST_RECONCILE_TOLERANCE_BPS,
    },
    MARKUP_BPS,
  );

  if (!drift.shouldCorrect) {
    await markStatus(row.id, 'reconciled', now);
    return 'reconciled';
  }

  const applied = await applyCorrection(row.userId, drift, row.id, ids);
  await markStatus(row.id, 'reconciled', now);
  if (applied) void emitCreditsUpdated(row.userId);
  return 'corrected';
}

export async function reconcileOpenRouterCosts(
  opts: { fetcher?: GenerationFetcher; now?: Date } = {},
): Promise<CostReconcileResult> {
  if (!isBillingEnabled()) return { fetched: 0, corrected: 0, unavailable: 0, skipped: 0 };

  const fetcher = opts.fetcher ?? defaultFetcher;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - GRACE_MS);

  let fetched = 0;
  let corrected = 0;
  let unavailable = 0;
  let skipped = 0;
  // Bound each row to one fetch attempt per run: rows that stay 'pending' (generation not
  // ready) don't drop out of the query, so without this they'd be re-hit every pass.
  const seen = new Set<string>();

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const rows = (await db
      .select({
        id: aiUsageLogs.id,
        userId: aiUsageLogs.userId,
        cost: aiUsageLogs.cost,
        metadata: aiUsageLogs.metadata,
        reconcileAttempts: aiUsageLogs.reconcileAttempts,
      })
      .from(aiUsageLogs)
      .where(
        and(
          eq(aiUsageLogs.reconcileStatus, 'pending'),
          lt(aiUsageLogs.timestamp, cutoff),
          lt(aiUsageLogs.reconcileAttempts, COST_RECONCILE_MAX_ATTEMPTS),
        ),
      )
      .limit(BATCH)) as PendingRow[];

    const fresh = rows.filter((r) => !seen.has(r.id));
    if (fresh.length === 0) break;

    for (const row of fresh) {
      seen.add(row.id);
      try {
        const outcome = await reconcileRow(row, fetcher, now);
        if (outcome === 'corrected') {
          corrected++;
          fetched++;
        } else if (outcome === 'reconciled') {
          fetched++;
        } else if (outcome === 'unavailable') {
          unavailable++;
        } else if (outcome === 'skipped') {
          skipped++;
        }
        // 'pending': attempts bumped; retried next run.
      } catch (error) {
        loggers.ai.debug('cost reconcile row failed', {
          error: (error as Error).message,
          aiUsageLogId: row.id,
        });
      }
    }

    // A short batch means there's nothing more to fetch this run.
    if (rows.length < BATCH) break;
  }

  return { fetched, corrected, unavailable, skipped };
}

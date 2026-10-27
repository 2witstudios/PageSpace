/**
 * stripe-reclaim — drains `app_hosting_stripe_reclaims`, the outbox that rescues
 * a dedicated published app's Stripe subscription id when its
 * `published_apps` row is deleted (see that outbox table's docblock and
 * `destroyPublishedApp`'s transaction in `@pagespace/lib/services/app-hosting/provisioner`).
 *
 * The cancel is IMMEDIATE (`stripe.subscriptions.cancel`), not the at-period-end
 * cancel the app-pane "cancel" button uses (`cancelDedicatedSubscription`): the
 * app itself no longer exists, so there is nothing left to keep serving for the
 * rest of the period, and leaving the subscription open would keep charging a
 * customer for hosting that was torn down.
 *
 * No advisory lock, same reasoning as `reconcile-orphaned-sprites`: the cancel is
 * idempotent (Stripe reports an already-canceled subscription as `canceled`
 * rather than erroring), and every row write here is a single UPDATE/DELETE by
 * primary key, so two overlapping runs converge rather than double-charge or
 * double-delete.
 */

import { and, asc, eq, lt } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { appHostingStripeReclaims, type AppHostingStripeReclaim } from '@pagespace/db/schema/app-hosting-stripe-reclaims';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { stripe, Stripe } from '@/lib/stripe';
import * as Sentry from '@sentry/nextjs';

/** Caps a single tick's work so one huge backlog can't blow the cron's time budget. */
export const STRIPE_RECLAIM_DRAIN_CAP = 200;

/** A reclaim is retried forever, but stops being retried EVERY tick once it looks stuck — an operator should look at it instead. */
export const STRIPE_RECLAIM_MAX_ATTEMPTS = 20;

/**
 * A reclaim row that has exhausted its attempts is a subscription this cron
 * can no longer cancel on its own — the row stays (so a manual fix is still
 * discoverable and the drain query still excludes it going forward), but
 * silence past this point would mean nobody ever finds out a customer may
 * still be paying for a torn-down app. Fingerprinted on the subscription id so
 * a stuck reclaim opens exactly one issue, not one per tick.
 */
function alertReclaimExhausted(stripeSubscriptionId: string, attempts: number, lastError: string | null): void {
  Sentry.captureMessage('App-hosting Stripe reclaim exhausted its cancel attempts', {
    level: 'error',
    fingerprint: ['app-hosting-stripe-reclaim-exhausted', stripeSubscriptionId],
    tags: { check: 'app_hosting_stripe_reclaim', reason: 'attempts_exhausted' },
    extra: { stripeSubscriptionId, attempts, lastError },
  });
}

export interface DrainStripeReclaimsResult {
  processed: number;
  canceled: number;
  alreadyCanceled: number;
  failed: number;
  capped: boolean;
}

type StopOutcome = { kind: 'stopped'; alreadyGone: boolean } | { kind: 'failed' };

/**
 * One attempt to stop one queued subscription as its row asks: cancel it now, or (`period_end`,
 * WAL-9, D-OW-64: its drive left the org paying for it) let it end with the period already paid
 * for. A failure is recorded on the row (CAS on `attempts`) and retried on a later tick.
 */
async function stopOnce(row: AppHostingStripeReclaim): Promise<StopOutcome> {
  try {
    const stop = row.cancelAt === 'period_end'
      ? stripe.subscriptions.update(row.stripeSubscriptionId, { cancel_at_period_end: true })
      : stripe.subscriptions.cancel(row.stripeSubscriptionId);
    const subscription = await stop.catch((error: unknown) => {
      // Already gone at Stripe (deleted account, or a prior tick's cancel that
      // committed there but crashed before this row could be removed) is the
      // success case, not a failure — the invariant this table protects
      // ("nobody keeps paying") already holds.
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing') {
        return null;
      }
      throw error;
    });

    if (subscription === null) return { kind: 'stopped', alreadyGone: true };
    if (subscription.status === 'canceled' || (row.cancelAt === 'period_end' && subscription.cancel_at_period_end === true)) {
      return { kind: 'stopped', alreadyGone: false };
    }

    // Stripe answered without the subscription being stopped (unexpected, but Stripe's response
    // is the fact here, not our assumption) — leave the row so the next tick tries again.
    await recordFailedAttempt(row, `cancel returned status "${subscription.status}"`);
    return { kind: 'failed' };
  } catch (error) {
    loggers.system.error(
      `[app-hosting-stripe-reclaim] cancel failed for subscription ${row.stripeSubscriptionId}`,
      error as Error,
    );
    await recordFailedAttempt(row, error instanceof Error ? error.message : 'unknown Stripe error');
    return { kind: 'failed' };
  }
}

/**
 * Count one failed attempt, CAS-guarded on `attempts`. Alert ONLY when THIS call's CAS actually
 * matched (won the race) AND pushed the row past the threshold — a lost race means some other
 * process already advanced (or reset) the row, and alerting on our own stale, unapplied
 * computation would be alerting on a write that never happened.
 */
async function recordFailedAttempt(row: AppHostingStripeReclaim, lastError: string): Promise<void> {
  const nextAttempts = row.attempts + 1;
  const [updatedRow] = await db
    .update(appHostingStripeReclaims)
    .set({ attempts: nextAttempts, lastAttemptAt: new Date(), lastError })
    .where(
      and(
        eq(appHostingStripeReclaims.stripeSubscriptionId, row.stripeSubscriptionId),
        eq(appHostingStripeReclaims.attempts, row.attempts),
      ),
    )
    .returning();
  if (updatedRow && nextAttempts >= STRIPE_RECLAIM_MAX_ATTEMPTS) {
    alertReclaimExhausted(row.stripeSubscriptionId, nextAttempts, lastError);
  }
}

/** The reclaim row as it is NOW, or null once it is gone. */
async function rereadReclaim(stripeSubscriptionId: string): Promise<AppHostingStripeReclaim | null> {
  const [fresh] = await db
    .select()
    .from(appHostingStripeReclaims)
    .where(eq(appHostingStripeReclaims.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  return fresh ?? null;
}

export async function drainAppHostingStripeReclaims(): Promise<DrainStripeReclaimsResult> {
  const rows = await db
    .select()
    .from(appHostingStripeReclaims)
    .where(lt(appHostingStripeReclaims.attempts, STRIPE_RECLAIM_MAX_ATTEMPTS))
    .orderBy(asc(appHostingStripeReclaims.recordedAt))
    .limit(STRIPE_RECLAIM_DRAIN_CAP + 1);

  const capped = rows.length > STRIPE_RECLAIM_DRAIN_CAP;
  const batch = capped ? rows.slice(0, STRIPE_RECLAIM_DRAIN_CAP) : rows;

  let canceled = 0;
  let alreadyCanceled = 0;
  let failed = 0;

  for (const queued of batch) {
    // A row is re-processed at most once more: the only change it can take while it is being
    // processed is a period-end release upgraded to an immediate cancel (the app was destroyed).
    let row: AppHostingStripeReclaim | null = queued;
    let outcome: StopOutcome = { kind: 'failed' };
    for (let pass = 0; row !== null && pass < 2; pass += 1) {
      const current: AppHostingStripeReclaim = row;
      outcome = await stopOnce(current);
      if (outcome.kind === 'failed') break;
      // COMPARE-AND-DELETE on the mode this pass acted on (D-OW-64): a concurrent upgrade of a
      // period-end release to an immediate cancel must not be discarded with it. If the row
      // changed, read it again and act on what it says now.
      const deleted: Array<{ stripeSubscriptionId: string }> = await db
        .delete(appHostingStripeReclaims)
        .where(and(
          eq(appHostingStripeReclaims.stripeSubscriptionId, current.stripeSubscriptionId),
          eq(appHostingStripeReclaims.cancelAt, current.cancelAt),
        ))
        .returning({ stripeSubscriptionId: appHostingStripeReclaims.stripeSubscriptionId });
      row = deleted.length > 0 ? null : await rereadReclaim(current.stripeSubscriptionId);
    }
    if (outcome.kind === 'failed') failed += 1;
    else if (outcome.alreadyGone) alreadyCanceled += 1;
    else canceled += 1;
  }

  return { processed: batch.length, canceled, alreadyCanceled, failed, capped };
}

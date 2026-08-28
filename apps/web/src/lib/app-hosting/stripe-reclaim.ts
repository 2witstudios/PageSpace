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
import { appHostingStripeReclaims } from '@pagespace/db/schema/app-hosting-stripe-reclaims';
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

  for (const row of batch) {
    try {
      const subscription = await stripe.subscriptions.cancel(row.stripeSubscriptionId).catch((error: unknown) => {
        // Already gone at Stripe (deleted account, or a prior tick's cancel that
        // committed there but crashed before this row could be removed) is the
        // success case, not a failure — the invariant this table protects
        // ("nobody keeps paying") already holds.
        if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === 'resource_missing') {
          return null;
        }
        throw error;
      });

      if (subscription === null || subscription.status === 'canceled') {
        alreadyCanceled += subscription === null ? 1 : 0;
        canceled += subscription === null ? 0 : 1;
        await db.delete(appHostingStripeReclaims).where(eq(appHostingStripeReclaims.stripeSubscriptionId, row.stripeSubscriptionId));
        continue;
      }

      // Cancel returned without reaching `canceled` (unexpected, but Stripe's
      // response is the fact here, not our assumption) — leave the row so the
      // next tick tries again rather than assuming success.
      failed += 1;
      const unexpectedStatusError = `cancel returned status "${subscription.status}"`;
      const nextAttempts = row.attempts + 1;
      await db
        .update(appHostingStripeReclaims)
        .set({ attempts: nextAttempts, lastAttemptAt: new Date(), lastError: unexpectedStatusError })
        .where(
          and(
            eq(appHostingStripeReclaims.stripeSubscriptionId, row.stripeSubscriptionId),
            eq(appHostingStripeReclaims.attempts, row.attempts),
          ),
        );
      if (nextAttempts >= STRIPE_RECLAIM_MAX_ATTEMPTS) {
        alertReclaimExhausted(row.stripeSubscriptionId, nextAttempts, unexpectedStatusError);
      }
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : 'unknown Stripe error';
      loggers.system.error(
        `[app-hosting-stripe-reclaim] cancel failed for subscription ${row.stripeSubscriptionId}`,
        error as Error,
      );
      const nextAttempts = row.attempts + 1;
      await db
        .update(appHostingStripeReclaims)
        .set({ attempts: nextAttempts, lastAttemptAt: new Date(), lastError: message })
        .where(
          and(
            eq(appHostingStripeReclaims.stripeSubscriptionId, row.stripeSubscriptionId),
            eq(appHostingStripeReclaims.attempts, row.attempts),
          ),
        );
      if (nextAttempts >= STRIPE_RECLAIM_MAX_ATTEMPTS) {
        alertReclaimExhausted(row.stripeSubscriptionId, nextAttempts, message);
      }
    }
  }

  return { processed: batch.length, canceled, alreadyCanceled, failed, capped };
}

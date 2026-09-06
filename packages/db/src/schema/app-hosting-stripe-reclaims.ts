import { pgTable, text, integer, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * appHostingStripeReclaims — the teardown OUTBOX for a published app's DEDICATED
 * Stripe subscription, mirroring `appHostingReclaims` (the Fly-app outbox) for
 * money instead of a machine.
 *
 * `published_app_subscriptions.publishedAppId` cascades on delete (see that
 * table's docblock): unpublishing an app deletes `published_apps`, which drops
 * the subscription mirror row with it — but that cascade does NOT touch Stripe.
 * Left alone, that is a customer who keeps paying a flat monthly charge for an
 * app that no longer exists — the exact billing-resource-stranding failure the
 * Sprite/Fly-app reclaim outboxes exist to prevent, just pointed the other way
 * (a dead local row with a still-live remote charge, instead of a dead remote
 * resource with no local pointer).
 *
 * So the unpublish path writes a row HERE, in the SAME transaction that deletes
 * `published_apps`, before the cascade removes the subscription mirror: either
 * the Stripe subscription id is rescued, or the delete does not commit. No
 * foreign key to `published_apps` or `published_app_subscriptions` on purpose —
 * an FK here would let the very delete this table exists to survive cascade the
 * rescued pointer away with it.
 *
 * The drain cron calls Stripe's cancel with the subscription id as its own
 * idempotency (cancelling an already-canceled subscription is a no-op success,
 * not an error), and removes the row only once Stripe confirms the subscription
 * is `canceled` — a failed cancel is retried forever rather than forgotten.
 */
export const appHostingStripeReclaims = pgTable('app_hosting_stripe_reclaims', {
  /**
   * The Stripe subscription to cancel. PRIMARY KEY, so re-enqueueing the same
   * subscription (a retried unpublish, or a hand-run delete) is one unit of work.
   */
  stripeSubscriptionId: text('stripeSubscriptionId').primaryKey(),

  /**
   * The `published_apps` row that died. Provenance only, and deliberately NOT a
   * foreign key for the same reason as `appHostingReclaims.publishedAppId`.
   */
  publishedAppId: text('publishedAppId'),

  /** When the pointer was rescued — i.e. when its `published_apps` row was deleted. */
  recordedAt: timestamp('recordedAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),

  /** Cancel attempts so far. A high count is a subscription that cannot be cancelled — a real, billing anomaly worth alerting on. */
  attempts: integer('attempts').default(0).notNull(),

  /** When the last cancel was attempted, and why it failed — the health signal for a stuck reclaim. */
  lastAttemptAt: timestamp('lastAttemptAt', { mode: 'date', withTimezone: true }),
  lastError: text('lastError'),
}, (table) => ({
  // The cron drains oldest-first, so it can be capped without starving a row.
  recordedAtIdx: index('app_hosting_stripe_reclaims_recorded_at_idx').on(table.recordedAt),
  attemptsNonNeg: check('app_hosting_stripe_reclaims_attempts_nonneg', sql`${table.attempts} >= 0`),
}));

export type AppHostingStripeReclaim = typeof appHostingStripeReclaims.$inferSelect;
export type NewAppHostingStripeReclaim = typeof appHostingStripeReclaims.$inferInsert;

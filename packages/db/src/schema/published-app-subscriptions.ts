import { pgTable, text, timestamp, boolean, index, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { publishedApps } from './published-apps';

/**
 * publishedAppSubscriptions — the Stripe mirror for the DEDICATED hosting SKU:
 * one flat monthly subscription per always-on published app.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT A ROW IN `subscriptions`, which is the question every reader
 * arrives with. `subscriptions` is the ACCOUNT PLAN mirror, and it is read as
 * one: `deriveTierFromSubscriptions` (billing/subscription-tier-sync.ts) walks a
 * user's rows there and writes the winner into `users.subscriptionTier`, the
 * column ~40 feature gates read. A dedicated-hosting subscription put in that
 * table would be an ENTITLED row carrying a price the account tier map has never
 * heard of, and that has two independent consequences, both bad:
 *
 *   1. The Stripe webhook derives from the SINGLE row in the event it just
 *      received. A hosting subscription's `customer.subscription.created` would
 *      therefore derive `free` and write it straight over a Pro / Founder /
 *      Business customer's tier — a paying user demoted by buying more.
 *   2. The reconcile cron would then see `indeterminate: true` (an entitled row
 *      on an unmapped price) for that user forever, and `isTierDriftRepairable`
 *      deliberately refuses to auto-repair such a user. The demotion in (1)
 *      would be permanent AND invisible to the repair path built for exactly
 *      that failure.
 *
 * Hosting spend is not a plan. It hangs off a published app, it is bought and
 * cancelled per app, and it says nothing about what the account is entitled to —
 * so it gets its own mirror and its own webhook branch (routed on the
 * subscription's `metadata.kind`, BEFORE the account-tier handler sees it).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The row is a MIRROR of Stripe, exactly as `subscriptions` is: Stripe is the
 * source of truth for money, this table is the source of truth for "may this app
 * be dedicated", and the webhook is the only thing that reconciles them. Nothing
 * here is authoritative on its own.
 */
export const publishedAppSubscriptions = pgTable('published_app_subscriptions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),

  /**
   * The app this subscription pays for. UNIQUE — an app has at most one
   * dedicated subscription, and the uniqueness is what makes "is this app paid
   * for" a single-row read rather than an aggregate over history.
   *
   * Cascades with the app: unpublishing deletes the `published_apps` row, and a
   * mirror row pointing at a vanished app is not a record worth keeping. THE
   * STRIPE SUBSCRIPTION IS NOT CANCELLED BY THAT CASCADE — cancelling at Stripe
   * is an API call the delete path must make, and this comment is here so nobody
   * reads the FK as if it did. A cascade that silently dropped the only local
   * pointer to a live recurring charge is precisely the shape that bills a
   * customer for an app that no longer exists.
   */
  publishedAppId: text('publishedAppId')
    .notNull()
    .unique()
    .references(() => publishedApps.id, { onDelete: 'cascade' }),

  /**
   * Who is billed. Denormalized from the app's payer at purchase time so a
   * customer-id lookup from a webhook lands on a user without joining through
   * the app and its drive — and so the row survives as an attributable record if
   * the drive later changes hands.
   */
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),

  /** Stripe's id for the subscription. Unique — the webhook's upsert target. */
  stripeSubscriptionId: text('stripeSubscriptionId').notNull().unique(),

  /** The flat monthly price actually charged. One price per guest preset. */
  stripePriceId: text('stripePriceId').notNull(),

  /**
   * The guest size this subscription pays for, recorded at purchase.
   *
   * Deliberately duplicated from `published_apps.guestPreset` rather than read
   * through it: the app's column is what we ask Fly for, and this is what the
   * customer agreed to pay. They should agree, and a disagreement is exactly the
   * thing worth being able to SEE — an app resized without its subscription
   * being moved to the matching price is a machine we are paying Fly for and
   * under-charging for, and it is undetectable if both facts live in one column.
   */
  guestPreset: text('guestPreset').notNull(),

  /** Stripe's status verbatim: active, trialing, past_due, canceled, unpaid, incomplete… */
  status: text('status').notNull(),

  currentPeriodStart: timestamp('currentPeriodStart', { mode: 'date', withTimezone: true }).notNull(),
  currentPeriodEnd: timestamp('currentPeriodEnd', { mode: 'date', withTimezone: true }).notNull(),
  cancelAtPeriodEnd: boolean('cancelAtPeriodEnd').default(false).notNull(),

  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date', withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
}, (table) => ({
  userIdx: index('published_app_subscriptions_user_idx').on(table.userId),
  stripeSubscriptionIdx: index('published_app_subscriptions_stripe_subscription_idx')
    .on(table.stripeSubscriptionId),
  // A status column that can be empty is a status column the entitlement read
  // cannot trust — `''` is not a Stripe status and would silently fall out of
  // every `IN (...)` the entitlement check makes, reading as "not entitled" for
  // a subscription that may well be active.
  statusNonEmpty: check(
    'published_app_subscriptions_status_nonempty',
    sql`length(${table.status}) > 0`,
  ),
  // A period that ends before it starts prices nothing and dates nothing; it can
  // only arrive from a bad write, and it would make any period arithmetic
  // (proration, a "renews on" string) negative.
  periodOrdered: check(
    'published_app_subscriptions_period_ordered',
    sql`${table.currentPeriodEnd} >= ${table.currentPeriodStart}`,
  ),
}));

export type PublishedAppSubscription = typeof publishedAppSubscriptions.$inferSelect;

export const publishedAppSubscriptionsRelations = relations(publishedAppSubscriptions, ({ one }) => ({
  app: one(publishedApps, {
    fields: [publishedAppSubscriptions.publishedAppId],
    references: [publishedApps.id],
  }),
  user: one(users, {
    fields: [publishedAppSubscriptions.userId],
    references: [users.id],
  }),
}));

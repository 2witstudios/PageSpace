import { pgTable, text, timestamp, boolean, index, integer, uuid, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

/**
 * App Store (StoreKit 2) purchases — the iOS counterpart of the Stripe mirror in
 * ./subscriptions. Kept in their own tables, never in `subscriptions`: every reader of
 * that table treats its ids as Stripe ids and calls Stripe with them. The tier a user
 * holds is derived across BOTH mirrors (lib billing/personal-tier), so a plan is one
 * fact whichever store sold it.
 *
 * Ids are Apple's: transactionId / originalTransactionId are decimal strings unique
 * across the App Store, so each table keys on them directly for idempotency.
 */

/**
 * One App Store account token per user — the UUID passed to StoreKit as
 * `appAccountToken` on every purchase. Apple echoes it on every signed transaction and
 * server notification, so a notification resolves to its buyer even when the device
 * never synced, and a transaction whose token belongs to someone else is refused (a
 * replayed receipt). Created on the first purchase attempt, never rotated.
 */
export const appStoreAccounts = pgTable('app_store_accounts', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  accountToken: uuid('accountToken').notNull().unique(),
  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
});

/** Lifecycle of an App Store auto-renewable subscription, as mirrored here. */
export const APP_STORE_SUBSCRIPTION_STATUSES = ['active', 'billing_retry', 'grace_period', 'expired', 'revoked'] as const;
export type AppStoreSubscriptionStatus = (typeof APP_STORE_SUBSCRIPTION_STATUSES)[number];

/** Apple's two signing environments the server accepts transactions from. */
export const APP_STORE_ENVIRONMENTS = ['Production', 'Sandbox'] as const;
export type AppStoreEnvironment = (typeof APP_STORE_ENVIRONMENTS)[number];

/**
 * One row per auto-renewable subscription (Apple's originalTransactionId), updated in
 * place as renewals, expiries and refunds arrive. `expiresAt` is the end of the paid
 * period: entitlement requires it to be in the future as well as an entitling status,
 * so a missed EXPIRED notification can never grant a tier forever.
 */
export const appStoreSubscriptions = pgTable('app_store_subscriptions', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  originalTransactionId: text('originalTransactionId').notNull().unique(),
  /** The most recent transaction applied — the renewal that set expiresAt. */
  latestTransactionId: text('latestTransactionId').notNull(),
  productId: text('productId').notNull(),
  status: text('status').$type<AppStoreSubscriptionStatus>().notNull(),
  environment: text('environment').$type<AppStoreEnvironment>().notNull(),
  currentPeriodStart: timestamp('currentPeriodStart', { mode: 'date', withTimezone: true }).notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date', withTimezone: true }).notNull(),
  /** From the signed renewal info: false once the user turned auto-renew off. */
  autoRenew: boolean('autoRenew').default(true).notNull(),
  /**
   * Apple's signedDate of the newest payload applied to this row. A payload signed
   * earlier (a replayed device post, a delayed notification retry) changes nothing:
   * Apple's own ordering, not arrival order, decides the state.
   */
  lastSignedAt: timestamp('lastSignedAt', { mode: 'date', withTimezone: true }),
  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date', withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  userIdx: index('app_store_subscriptions_user_idx').on(table.userId),
  statusValid: check('app_store_subscriptions_status_valid', sql`${table.status} IN ('active', 'billing_retry', 'grace_period', 'expired', 'revoked')`),
  environmentValid: check('app_store_subscriptions_environment_valid', sql`${table.environment} IN ('Production', 'Sandbox')`),
}));

/**
 * Every signed transaction the server has accepted — a purchase, a renewal, a
 * consumable — kept for accounting (Apple's gross price and currency, which the
 * credit ledger deliberately does not carry: grants are sized from the web-equivalent
 * price) and for refunds, which arrive naming a transactionId. The credit ledger row a
 * transaction funded is keyed `apple:<transactionId>` on credit_ledger.stripeRef, so
 * funding is exactly-once independently of this table.
 */
export const appStoreTransactions = pgTable('app_store_transactions', {
  transactionId: text('transactionId').primaryKey(),
  originalTransactionId: text('originalTransactionId').notNull(),
  /** Financial record: kept, anonymised, when the buyer deletes their account. */
  userId: text('userId').references(() => users.id, { onDelete: 'set null' }),
  productId: text('productId').notNull(),
  productKind: text('productKind').$type<'subscription' | 'consumable'>().notNull(),
  environment: text('environment').$type<AppStoreEnvironment>().notNull(),
  purchaseDate: timestamp('purchaseDate', { mode: 'date', withTimezone: true }).notNull(),
  expiresDate: timestamp('expiresDate', { mode: 'date', withTimezone: true }),
  /** Apple's price in milliunits of `currency` (e.g. 17990 = 17.99), when Apple sent one. */
  priceMilliunits: integer('priceMilliunits'),
  currency: text('currency'),
  storefront: text('storefront'),
  revokedAt: timestamp('revokedAt', { mode: 'date', withTimezone: true }),
  /** Apple's signedDate of the newest payload applied (see app_store_subscriptions.lastSignedAt). */
  lastSignedAt: timestamp('lastSignedAt', { mode: 'date', withTimezone: true }),
  /** When this transaction first funded credit (null: never) — the Sandbox funding cap counts it. */
  fundedAt: timestamp('fundedAt', { mode: 'date', withTimezone: true }),
  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdx: index('app_store_transactions_user_idx').on(table.userId),
  originalIdx: index('app_store_transactions_original_idx').on(table.originalTransactionId),
  kindValid: check('app_store_transactions_kind_valid', sql`${table.productKind} IN ('subscription', 'consumable')`),
}));

/**
 * App Store Server Notifications V2 idempotency — the counterpart of stripe_events.
 * The row is INSERTed to claim the notificationUUID and processedAt is set only once
 * processing finished, so a null processedAt means "claimed but not processed" (in
 * flight or failed) and a redelivery is reprocessed rather than acked.
 */
export const appStoreNotifications = pgTable('app_store_notifications', {
  notificationUUID: text('notificationUUID').primaryKey(),
  type: text('type').notNull(),
  subtype: text('subtype'),
  processedAt: timestamp('processedAt', { mode: 'date', withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  processedAtIdx: index('app_store_notifications_processed_at_idx').on(table.processedAt),
}));

export const appStoreAccountsRelations = relations(appStoreAccounts, ({ one }) => ({
  user: one(users, { fields: [appStoreAccounts.userId], references: [users.id] }),
}));

export const appStoreSubscriptionsRelations = relations(appStoreSubscriptions, ({ one }) => ({
  user: one(users, { fields: [appStoreSubscriptions.userId], references: [users.id] }),
}));

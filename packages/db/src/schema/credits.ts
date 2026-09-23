import { pgTable, text, integer, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { wallets } from './wallets';

/**
 * creditLedger — append-only audit/provenance. One row per grant, purchase, or
 * usage decrement. The unique indexes are the correctness backbone:
 *   - one USAGE decrement per aiUsageLogId  (each AI call billed exactly once)
 *   - one credit per stripeRef              (each payment credited exactly once)
 * aiUsageLogId is a soft link (no FK) because aiUsageLogs is purged on retention.
 * The usage-log index is scoped to entryType='usage' on purpose: a uncovered-cost
 * 'adjustment' (debt) row is written alongside the usage row and links to the SAME
 * aiUsageLogId, so the uniqueness must apply to the usage decrement only.
 */
export const creditLedger = pgTable('credit_ledger', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // WAL-5: the wallet this row moved money in or out of. For every row written before
  // wallets existed it is the user's personal root wallet (backfilled by 0303/0304).
  walletId: text('walletId').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
  entryType: text('entryType').notNull(), // 'monthly_grant' | 'topup_purchase' | 'usage' | 'adjustment' | 'missed_grant' (a paid invoice whose tier had no ratio: amountCents 0, for the reconcile cron to re-grant)
  bucket: text('bucket').notNull(), // 'monthly' | 'topup'
  amountCents: integer('amountCents').notNull(), // signed full intended charge: grants/purchases +, usage/debt -
  appliedCents: integer('appliedCents'), // signed amount actually decremented from the balance (usage rows). |applied| <= |amount|; the gap is debt recorded as an adjustment row.
  chargeMillicents: integer('chargeMillicents'), // precise per-call charge in millicents (usage rows) — the sub-cent-accurate source for settlement/retry
  aiUsageLogId: text('aiUsageLogId'), // soft link to aiUsageLogs.id (no FK)
  realCostCents: integer('realCostCents'), // round(cost*100) pre-markup, for audit
  markupBps: integer('markupBps').default(15000).notNull(),
  stripeRef: text('stripeRef'), // invoice id / checkout session id for grants & purchases
  paidCents: integer('paidCents'), // what the Stripe invoice actually paid (monthly_grant rows) — the grant is derived from it (MON-2), so the ratio is auditable per row
  consumeStatus: text('consumeStatus').default('pending').notNull(), // 'pending' | 'applied' | 'skipped'
  consumeError: text('consumeError'),
  // Idempotency arbiter for the async cost-reconcile cron's correction rows. The usage
  // unique index is scoped to entryType='usage', so it does NOT block a second
  // 'adjustment' for the same aiUsageLogId; this key (the sorted-joined OpenRouter
  // generation ids) does. Set only on reconcile adjustment rows; NULL everywhere else.
  reconcileGenerationKey: text('reconcileGenerationKey'),
  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdx: index('credit_ledger_user_idx').on(table.userId, table.createdAt),
  walletIdx: index('credit_ledger_wallet_idx').on(table.walletId, table.createdAt),
  usageLogUnique: uniqueIndex('credit_ledger_usage_log_unique')
    .on(table.aiUsageLogId)
    .where(sql`${table.aiUsageLogId} IS NOT NULL AND ${table.entryType} = 'usage'`),
  stripeRefUnique: uniqueIndex('credit_ledger_stripe_ref_unique')
    .on(table.stripeRef)
    .where(sql`${table.stripeRef} IS NOT NULL`),
  // One reconcile correction per generation set — makes a re-run / overlapping cron a no-op.
  reconcileKeyUnique: uniqueIndex('credit_ledger_reconcile_key_unique')
    .on(table.reconcileGenerationKey)
    .where(sql`${table.reconcileGenerationKey} IS NOT NULL`),
  consumeStatusIdx: index('credit_ledger_consume_status_idx').on(table.consumeStatus, table.createdAt),
}));

/**
 * creditHolds — short-lived reservations placed by the gate BEFORE a call and
 * released at settle. The gate checks the balance up front but the real cost is
 * only known after the stream, so a hold does two jobs at once:
 *   - reserves `estCents` of estimated spend, subtracted from spendable in the
 *     gate decision so concurrent calls can't collectively overshoot the balance
 *   - serves as the in-flight counter — the free-tier concurrency cap is just a
 *     COUNT of this user's non-expired holds
 * consumeCredits deletes the hold inside the settle transaction. A crashed stream
 * leaves an orphan hold that would permanently shrink spendable, so the reconcile
 * cron sweeps any hold past `expiresAt`. `aiUsageLogId` is a nullable soft link
 * (no FK) recorded for provenance when the settling call is known.
 */
export const creditHolds = pgTable('credit_holds', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // WAL-5: holds are per wallet — the wallet this reservation is against.
  walletId: text('walletId').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
  estCents: integer('estCents').notNull(),
  aiUsageLogId: text('aiUsageLogId'),
  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date', withTimezone: true }).notNull(),
}, (table) => ({
  // The gate sums & counts a user's non-expired holds on every request — index the
  // hot lookup. The expiry index keeps the reconcile sweep (DELETE WHERE expiresAt
  // < now) cheap as the table grows.
  userIdx: index('credit_holds_user_idx').on(table.userId),
  walletIdx: index('credit_holds_wallet_idx').on(table.walletId),
  expiresIdx: index('credit_holds_expires_idx').on(table.expiresAt),
  estNonNeg: check('credit_holds_est_cents_nonneg', sql`${table.estCents} >= 0`),
}));

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  user: one(users, {
    fields: [creditLedger.userId],
    references: [users.id],
  }),
  wallet: one(wallets, {
    fields: [creditLedger.walletId],
    references: [wallets.id],
  }),
}));

export const creditHoldsRelations = relations(creditHolds, ({ one }) => ({
  user: one(users, {
    fields: [creditHolds.userId],
    references: [users.id],
  }),
  wallet: one(wallets, {
    fields: [creditHolds.walletId],
    references: [wallets.id],
  }),
}));

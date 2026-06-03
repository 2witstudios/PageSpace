import { pgTable, text, integer, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';

/**
 * creditBalances — denormalized, one row per user. The fast pre-request gate and
 * the dashboard read this. Two buckets:
 *   - monthly: subscription allowance, RESET each period (use-it-or-lose-it)
 *   - topup:   purchased packs, NEVER expire
 * Spendable = monthlyRemainingCents + topupRemainingCents.
 */
export const creditBalances = pgTable('credit_balances', {
  userId: text('userId').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  monthlyRemainingCents: integer('monthlyRemainingCents').default(0).notNull(),
  monthlyAllowanceCents: integer('monthlyAllowanceCents').default(0).notNull(),
  topupRemainingCents: integer('topupRemainingCents').default(0).notNull(),
  // Sub-cent carry: a single AI call can cost a fraction of a cent (high-volume
  // cheap models). We charge in millicents (1/1000 cent) and bank the leftover
  // fraction here so those calls don't silently round to $0. Always in [0, 1000):
  // each settle debits floor((pending + charge)/1000) whole cents and keeps the
  // remainder. Never a float — integer millicents only.
  pendingMillicents: integer('pendingMillicents').default(0).notNull(),
  monthlyPeriodStart: timestamp('monthlyPeriodStart', { mode: 'date', withTimezone: true }),
  monthlyPeriodEnd: timestamp('monthlyPeriodEnd', { mode: 'date', withTimezone: true }),
  updatedAt: timestamp('updatedAt', { mode: 'date', withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  // The prepaid source of truth: enforce the invariants in the DB so a single bad
  // write can't manufacture negative balances or an inverted billing window that
  // the gate would treat as real spendable state.
  monthlyNonNeg: check('credit_balances_monthly_remaining_nonneg', sql`${table.monthlyRemainingCents} >= 0`),
  allowanceNonNeg: check('credit_balances_monthly_allowance_nonneg', sql`${table.monthlyAllowanceCents} >= 0`),
  topupNonNeg: check('credit_balances_topup_remaining_nonneg', sql`${table.topupRemainingCents} >= 0`),
  // The carry is a sub-cent fraction by construction; bound it so a bad write
  // can't park whole cents of unbilled value here, out of sight of the balance.
  pendingRange: check('credit_balances_pending_millicents_range', sql`${table.pendingMillicents} >= 0 AND ${table.pendingMillicents} < 1000`),
  periodOrder: check(
    'credit_balances_period_order',
    sql`${table.monthlyPeriodStart} IS NULL OR ${table.monthlyPeriodEnd} IS NULL OR ${table.monthlyPeriodStart} <= ${table.monthlyPeriodEnd}`,
  ),
}));

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
  entryType: text('entryType').notNull(), // 'monthly_grant' | 'topup_purchase' | 'usage' | 'adjustment'
  bucket: text('bucket').notNull(), // 'monthly' | 'topup'
  amountCents: integer('amountCents').notNull(), // signed full intended charge: grants/purchases +, usage/debt -
  appliedCents: integer('appliedCents'), // signed amount actually decremented from the balance (usage rows). |applied| <= |amount|; the gap is debt recorded as an adjustment row.
  chargeMillicents: integer('chargeMillicents'), // precise per-call charge in millicents (usage rows) — the sub-cent-accurate source for settlement/retry
  aiUsageLogId: text('aiUsageLogId'), // soft link to aiUsageLogs.id (no FK)
  realCostCents: integer('realCostCents'), // round(cost*100) pre-markup, for audit
  markupBps: integer('markupBps').default(15000).notNull(),
  stripeRef: text('stripeRef'), // invoice id / checkout session id for grants & purchases
  consumeStatus: text('consumeStatus').default('pending').notNull(), // 'pending' | 'applied' | 'skipped'
  consumeError: text('consumeError'),
  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  userIdx: index('credit_ledger_user_idx').on(table.userId, table.createdAt),
  usageLogUnique: uniqueIndex('credit_ledger_usage_log_unique')
    .on(table.aiUsageLogId)
    .where(sql`${table.aiUsageLogId} IS NOT NULL AND ${table.entryType} = 'usage'`),
  stripeRefUnique: uniqueIndex('credit_ledger_stripe_ref_unique')
    .on(table.stripeRef)
    .where(sql`${table.stripeRef} IS NOT NULL`),
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
  estCents: integer('estCents').notNull(),
  aiUsageLogId: text('aiUsageLogId'),
  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expiresAt', { mode: 'date', withTimezone: true }).notNull(),
}, (table) => ({
  // The gate sums & counts a user's non-expired holds on every request — index the
  // hot lookup. The expiry index keeps the reconcile sweep (DELETE WHERE expiresAt
  // < now) cheap as the table grows.
  userIdx: index('credit_holds_user_idx').on(table.userId),
  expiresIdx: index('credit_holds_expires_idx').on(table.expiresAt),
  estNonNeg: check('credit_holds_est_cents_nonneg', sql`${table.estCents} >= 0`),
}));

export const creditBalancesRelations = relations(creditBalances, ({ one }) => ({
  user: one(users, {
    fields: [creditBalances.userId],
    references: [users.id],
  }),
}));

export const creditLedgerRelations = relations(creditLedger, ({ one }) => ({
  user: one(users, {
    fields: [creditLedger.userId],
    references: [users.id],
  }),
}));

export const creditHoldsRelations = relations(creditHolds, ({ one }) => ({
  user: one(users, {
    fields: [creditHolds.userId],
    references: [users.id],
  }),
}));

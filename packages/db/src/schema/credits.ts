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
  periodOrder: check(
    'credit_balances_period_order',
    sql`${table.monthlyPeriodStart} IS NULL OR ${table.monthlyPeriodEnd} IS NULL OR ${table.monthlyPeriodStart} <= ${table.monthlyPeriodEnd}`,
  ),
}));

/**
 * creditLedger — append-only audit/provenance. One row per grant, purchase, or
 * usage decrement. The unique indexes are the correctness backbone:
 *   - one decrement per aiUsageLogId  (each AI call billed exactly once)
 *   - one credit per stripeRef        (each payment credited exactly once)
 * aiUsageLogId is a soft link (no FK) because aiUsageLogs is purged on retention.
 */
export const creditLedger = pgTable('credit_ledger', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  userId: text('userId').notNull().references(() => users.id, { onDelete: 'cascade' }),
  entryType: text('entryType').notNull(), // 'monthly_grant' | 'topup_purchase' | 'usage' | 'adjustment'
  bucket: text('bucket').notNull(), // 'monthly' | 'topup'
  amountCents: integer('amountCents').notNull(), // signed: grants/purchases +, usage -
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
    .where(sql`${table.aiUsageLogId} IS NOT NULL`),
  stripeRefUnique: uniqueIndex('credit_ledger_stripe_ref_unique')
    .on(table.stripeRef)
    .where(sql`${table.stripeRef} IS NOT NULL`),
  consumeStatusIdx: index('credit_ledger_consume_status_idx').on(table.consumeStatus, table.createdAt),
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

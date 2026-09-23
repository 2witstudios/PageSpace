import { pgTable, text, integer, timestamp, boolean, index, uniqueIndex, check, primaryKey, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { relations, sql, and, eq, isNull, type SQL } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { users } from './auth';
import { organizations } from './organizations';

/**
 * wallets — every balance in PageSpace (Spec WAL-1, WAL-2; X-5).
 *
 * X-5: this IS the table that used to be `credit_balances`. Migration 0300 renamed it
 * in place, so every per-user balance row became that user's PERSONAL ROOT WALLET
 * without a copy: same row, same cents. There is no second balance store.
 *
 * Shapes (WAL-2):
 *   - personal root wallet: ownerType 'user', no subject, no parent. One per user.
 *   - org pool:             ownerType 'org', no subject, no parent. One per org.
 *   - drive / agent wallet: a subject (drive or agent page), normally a parent (the org
 *                           pool for org drives, the owner's personal wallet for
 *                           personal drives).
 *
 * Money columns (whole cents of credit value, never negative, as credit_balances was):
 *   - monthlyRemainingCents: a ROOT wallet's allowance bucket (credit-core `Balance`).
 *                            Paid tiers accumulate it across periods (rollover).
 *   - monthlyAllowanceCents: the monthly allocation. On a root wallet, the tier grant;
 *                            on a child wallet, the budget drawn against the parent as
 *                            spend happens (WAL-3, wallet-core `WalletFunds`).
 *   - spentCents:            how much of a CHILD wallet's allocation this period has
 *                            drawn. Always 0 on a root wallet, whose spend lands in
 *                            monthlyRemainingCents instead.
 *   - topupRemainingCents:   funds moved in that last until spent (WAL-3).
 *   - debtCents:             overage owed, a non-negative magnitude (WAL-6).
 *   - pendingMillicents:     the sub-cent carry, always in [0, 1000).
 * Net spendable of a root wallet = monthlyRemaining + topupRemaining − debt, exactly the
 * credit_balances formula.
 *
 * The owner is two nullable foreign keys rather than one polymorphic id, so deleting a
 * user still cascades their personal wallet exactly as it cascaded their credit_balances
 * row (and an org's with the org). `ownerType` names which one is set; a CHECK keeps the
 * two in agreement. The subject is a soft link (subjectType + subjectId): its lifecycle
 * belongs to the lanes that create drive and agent wallets.
 */

export const WALLET_OWNER_TYPES = ['user', 'org'] as const;
export type WalletOwnerType = (typeof WALLET_OWNER_TYPES)[number];

export const WALLET_SUBJECT_TYPES = ['drive', 'agent_page'] as const;
export type WalletSubjectType = (typeof WALLET_SUBJECT_TYPES)[number];

/** WAL-1. `paused` is the kill switch (WAL-7); `over` carries debt (WAL-6e). Mirrors wallet-core `WalletStatus`. */
export const WALLET_STATUSES = ['active', 'paused', 'over'] as const;
export type WalletStatusValue = (typeof WALLET_STATUSES)[number];

/** POL-7. Mirrors wallet-core `FallbackRule`; null on a wallet means none set. */
export const WALLET_FALLBACK_RULES = ['refuse', 'seat_allowance', 'own_credits'] as const;
export type WalletFallbackRuleValue = (typeof WALLET_FALLBACK_RULES)[number];

export const wallets = pgTable('wallets', {
  // Existing credit_balances rows receive their id from the database default when 0302
  // adds the column; application inserts mint a cuid as every other table does. The
  // default is cuid-shaped (a letter, then 23 lowercase alphanumerics) so an id minted by
  // either path passes the same id validators.
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId())
    .default(sql`('w' || substr(md5(random()::text || clock_timestamp()::text), 1, 23))`),
  ownerType: text('ownerType').$type<WalletOwnerType>().default('user').notNull(),
  userId: text('userId').references(() => users.id, { onDelete: 'cascade' }),
  orgId: text('orgId').references(() => organizations.id, { onDelete: 'cascade' }),
  subjectType: text('subjectType').$type<WalletSubjectType>(),
  subjectId: text('subjectId'),
  parentWalletId: text('parentWalletId').references((): AnyPgColumn => wallets.id),
  monthlyRemainingCents: integer('monthlyRemainingCents').default(0).notNull(),
  monthlyAllowanceCents: integer('monthlyAllowanceCents').default(0).notNull(),
  spentCents: integer('spentCents').default(0).notNull(),
  topupRemainingCents: integer('topupRemainingCents').default(0).notNull(),
  debtCents: integer('debtCents').default(0).notNull(),
  // Sub-cent carry: a single AI call can cost a fraction of a cent. We charge in
  // millicents and bank the leftover fraction here so those calls don't silently round
  // to $0. Always in [0, 1000). Never a float — integer millicents only.
  pendingMillicents: integer('pendingMillicents').default(0).notNull(),
  // The UTC period (WAL-1). A root wallet's billing window; a child wallet's allocation
  // period, which follows its governing parent (D-OW-12).
  monthlyPeriodStart: timestamp('monthlyPeriodStart', { mode: 'date', withTimezone: true }),
  monthlyPeriodEnd: timestamp('monthlyPeriodEnd', { mode: 'date', withTimezone: true }),
  status: text('status').$type<WalletStatusValue>().default('active').notNull(),
  // WAL-4: the drive lead can turn donations off. On by default.
  donationsEnabled: boolean('donationsEnabled').default(true).notNull(),
  fallbackRule: text('fallbackRule').$type<WalletFallbackRuleValue>(),
  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date', withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  // One personal root wallet per user, one pool per org. These are the arbiters every
  // upsert of a personal balance names (see PERSONAL_ROOT_WALLET_ARBITER).
  personalRootUnique: uniqueIndex('wallets_personal_root_unique')
    .on(table.userId)
    .where(sql`"ownerType" = 'user' AND "subjectType" IS NULL AND "parentWalletId" IS NULL`),
  orgPoolUnique: uniqueIndex('wallets_org_pool_unique')
    .on(table.orgId)
    .where(sql`"ownerType" = 'org' AND "subjectType" IS NULL AND "parentWalletId" IS NULL`),
  // A drive or agent page has at most one wallet.
  subjectUnique: uniqueIndex('wallets_subject_unique')
    .on(table.subjectType, table.subjectId)
    .where(sql`"subjectId" IS NOT NULL`),
  parentIdx: index('wallets_parent_idx').on(table.parentWalletId),

  ownerTypeValid: check('wallets_owner_type_valid', sql`${table.ownerType} IN ('user', 'org')`),
  // Exactly the owner ownerType names, and never both.
  ownerMatchesType: check(
    'wallets_owner_matches_type',
    sql`(${table.ownerType} = 'user' AND ${table.userId} IS NOT NULL AND ${table.orgId} IS NULL) OR (${table.ownerType} = 'org' AND ${table.orgId} IS NOT NULL AND ${table.userId} IS NULL)`,
  ),
  subjectTypeValid: check(
    'wallets_subject_type_valid',
    sql`${table.subjectType} IS NULL OR ${table.subjectType} IN ('drive', 'agent_page')`,
  ),
  // Both or neither: a subject type without an id (or the reverse) names nothing.
  subjectComplete: check('wallets_subject_complete', sql`(${table.subjectType} IS NULL) = (${table.subjectId} IS NULL)`),
  notOwnParent: check('wallets_not_own_parent', sql`${table.parentWalletId} IS NULL OR ${table.parentWalletId} <> ${table.id}`),
  statusValid: check('wallets_status_valid', sql`${table.status} IN ('active', 'paused', 'over')`),
  fallbackRuleValid: check(
    'wallets_fallback_rule_valid',
    sql`${table.fallbackRule} IS NULL OR ${table.fallbackRule} IN ('refuse', 'seat_allowance', 'own_credits')`,
  ),

  // The credit_balances invariants, carried over unchanged: a single bad write can't
  // manufacture a negative bucket or an inverted billing window.
  monthlyNonNeg: check('wallets_monthly_remaining_nonneg', sql`${table.monthlyRemainingCents} >= 0`),
  allowanceNonNeg: check('wallets_monthly_allowance_nonneg', sql`${table.monthlyAllowanceCents} >= 0`),
  spentNonNeg: check('wallets_spent_cents_nonneg', sql`${table.spentCents} >= 0`),
  topupNonNeg: check('wallets_topup_remaining_nonneg', sql`${table.topupRemainingCents} >= 0`),
  debtNonNeg: check('wallets_debt_cents_nonneg', sql`${table.debtCents} >= 0`),
  pendingRange: check('wallets_pending_millicents_range', sql`${table.pendingMillicents} >= 0 AND ${table.pendingMillicents} < 1000`),
  periodOrder: check(
    'wallets_period_order',
    sql`${table.monthlyPeriodStart} IS NULL OR ${table.monthlyPeriodEnd} IS NULL OR ${table.monthlyPeriodStart} <= ${table.monthlyPeriodEnd}`,
  ),
}));

/**
 * Every personal root wallet: user-owned, no subject, no parent. Each is the row that was
 * one user's credit_balances row. Reports that were "per user balance" filter on this.
 */
export function isPersonalRootWallet(): SQL {
  return and(eq(wallets.ownerType, 'user'), isNull(wallets.subjectType), isNull(wallets.parentWalletId)) as SQL;
}

/**
 * The personal root wallet of `userId`: the row that was their credit_balances row.
 * Every read or write of a person's own balance goes through this predicate, never a
 * bare `userId` match, which would also match drive wallets that person owns.
 */
export function personalRootWalletOf(userId: string): SQL {
  return and(eq(wallets.userId, userId), isPersonalRootWallet()) as SQL;
}

/**
 * ON CONFLICT arbiter for inserting a personal root wallet. The unique index is
 * partial, and Postgres infers a partial index only when the conflict clause restates
 * its predicate. Use as `onConflictDoNothing(PERSONAL_ROOT_WALLET_ARBITER)`, or spread
 * `{ target, targetWhere }` into `onConflictDoUpdate`.
 */
export const PERSONAL_ROOT_WALLET_ARBITER = {
  target: wallets.userId,
  where: sql`"ownerType" = 'user' AND "subjectType" IS NULL AND "parentWalletId" IS NULL`,
} as const;

export const PERSONAL_ROOT_WALLET_UPSERT_TARGET = {
  target: wallets.userId,
  targetWhere: PERSONAL_ROOT_WALLET_ARBITER.where,
} as const;

/**
 * walletConsumerCaps — per-consumer daily and monthly caps on one wallet leg (WAL-7),
 * keyed (walletId, consumerKey). A null cap is unlimited within the wallet; no row at
 * all means no caps. `consumerKey` names who spends: `user:<userId>` for a person,
 * `drive:<driveId>` for automations that spend as the drive (SPEND-6). Whole cents.
 */
export const walletConsumerCaps = pgTable('wallet_consumer_caps', {
  walletId: text('walletId').notNull().references(() => wallets.id, { onDelete: 'cascade' }),
  consumerKey: text('consumerKey').notNull(),
  dailyCapCents: integer('dailyCapCents'),
  monthlyCapCents: integer('monthlyCapCents'),
  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updatedAt', { mode: 'date', withTimezone: true }).defaultNow().notNull().$onUpdate(() => new Date()),
}, (table) => ({
  pk: primaryKey({ columns: [table.walletId, table.consumerKey], name: 'wallet_consumer_caps_pkey' }),
  consumerKeyNonEmpty: check('wallet_consumer_caps_consumer_key_nonempty', sql`length(${table.consumerKey}) > 0`),
  dailyNonNeg: check('wallet_consumer_caps_daily_nonneg', sql`${table.dailyCapCents} IS NULL OR ${table.dailyCapCents} >= 0`),
  monthlyNonNeg: check('wallet_consumer_caps_monthly_nonneg', sql`${table.monthlyCapCents} IS NULL OR ${table.monthlyCapCents} >= 0`),
}));

export const walletsRelations = relations(wallets, ({ one, many }) => ({
  user: one(users, {
    fields: [wallets.userId],
    references: [users.id],
  }),
  org: one(organizations, {
    fields: [wallets.orgId],
    references: [organizations.id],
  }),
  parent: one(wallets, {
    fields: [wallets.parentWalletId],
    references: [wallets.id],
    relationName: 'walletParent',
  }),
  children: many(wallets, { relationName: 'walletParent' }),
  consumerCaps: many(walletConsumerCaps),
}));

export const walletConsumerCapsRelations = relations(walletConsumerCaps, ({ one }) => ({
  wallet: one(wallets, {
    fields: [walletConsumerCaps.walletId],
    references: [wallets.id],
  }),
}));

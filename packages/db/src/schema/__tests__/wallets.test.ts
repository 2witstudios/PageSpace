/**
 * Organizations & Wallets epic, Wave C1 — schema-level proof of the wallets table (the
 * former credit_balances), walletId on the ledger, holds and AI usage log, and the
 * per-consumer caps table. Runs without a database; the constraints and the money
 * invariants of the migration are exercised against a real Postgres in
 * `src/__tests__/wallets-migration.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { getTableColumns, is, SQL } from 'drizzle-orm';
import * as schemaModule from '../../schema';
import {
  wallets,
  walletConsumerCaps,
  personalRootWalletOf,
  isPersonalRootWallet,
  PERSONAL_ROOT_WALLET_ARBITER,
  WALLET_STATUSES,
  WALLET_FALLBACK_RULES,
  SPEND_SOURCE_KINDS,
} from '../wallets';
import { conversations } from '../conversations';
import { creditLedger, creditHolds } from '../credits';
import { aiUsageLogs } from '../monitoring';

const dialect = new PgDialect();

function foreignKeyOn(table: PgTable, column: string) {
  const fk = getTableConfig(table).foreignKeys.find((f) => f.reference().columns.some((c) => c.name === column));
  if (!fk) throw new Error(`no FK on ${column}`);
  return { onDelete: fk.onDelete, target: getTableConfig(fk.reference().foreignTable).name };
}

function indexNamed(table: PgTable, name: string) {
  const found = getTableConfig(table).indexes.find((i) => i.config.name === name);
  if (!found) throw new Error(`no index named ${name}`);
  return {
    unique: found.config.unique,
    columns: found.config.columns.map((c) => (is(c, SQL) ? dialect.sqlToQuery(c).sql : 'name' in c ? c.name : undefined)),
    where: found.config.where ? dialect.sqlToQuery(found.config.where).sql : undefined,
  };
}

function checkNames(table: PgTable): string[] {
  return getTableConfig(table).checks.map((c) => c.name).sort();
}

const PERSONAL_ROOT = `"ownerType" = 'user' AND "subjectType" IS NULL AND "parentWalletId" IS NULL`;

describe('wallets', () => {
  const columns = getTableColumns(wallets);

  it('X-5 (partial): is registered in the schema barrel and credit_balances is not', () => {
    expect(schemaModule.schema.wallets).toBe(wallets);
    expect(schemaModule.schema.walletConsumerCaps).toBe(walletConsumerCaps);
    expect(getTableConfig(wallets).name).toBe('wallets');
    expect(Object.keys(schemaModule.schema)).not.toContain('creditBalances');
  });

  it('WAL-1 (partial): carries owner, optional subject, optional parent, allocation, spent, top-up, debt, UTC period, status', () => {
    expect(Object.keys(columns).sort()).toEqual([
      'createdAt', 'debtCents', 'defaultSpendSource', 'donationsEnabled', 'fallbackRule', 'id', 'monthlyAllowanceCents',
      'monthlyPeriodEnd', 'monthlyPeriodStart', 'monthlyRemainingCents', 'orgId', 'ownerType',
      'parentWalletId', 'pendingMillicents', 'spentCents', 'status', 'subjectId', 'subjectType',
      'topupRemainingCents', 'updatedAt', 'userId',
    ]);
    for (const money of ['monthlyRemainingCents', 'monthlyAllowanceCents', 'spentCents', 'topupRemainingCents', 'debtCents', 'pendingMillicents'] as const) {
      expect(columns[money].dataType, money).toBe('number');
      expect(columns[money].columnType, money).toBe('PgInteger');
      expect(columns[money].notNull, money).toBe(true);
    }
    expect(columns.monthlyPeriodStart.columnType).toBe('PgTimestamp');
    expect(getTableConfig(wallets).columns.find((c) => c.name === 'monthlyPeriodStart')?.getSQLType()).toBe('timestamp with time zone');
    expect(columns.status.default).toBe('active');
    expect(WALLET_STATUSES).toEqual(['active', 'paused', 'over']);
    expect(WALLET_FALLBACK_RULES).toEqual(['refuse', 'seat_allowance', 'own_credits']);
    expect(columns.donationsEnabled.default).toBe(true);
  });

  it('WAL-1 (partial): keeps every credit_balances non-negativity CHECK, plus the wallet shape CHECKs', () => {
    expect(checkNames(wallets)).toEqual([
      'wallets_debt_cents_nonneg',
      'wallets_default_spend_source_valid',
      'wallets_fallback_rule_valid',
      'wallets_monthly_allowance_nonneg',
      'wallets_monthly_remaining_nonneg',
      'wallets_not_own_parent',
      'wallets_owner_matches_type',
      'wallets_owner_type_valid',
      'wallets_pending_millicents_range',
      'wallets_period_order',
      'wallets_spent_cents_nonneg',
      'wallets_status_valid',
      'wallets_subject_complete',
      'wallets_subject_type_valid',
      'wallets_topup_remaining_nonneg',
    ]);
  });

  it('X-5 (partial): deleting a user or an org cascades its wallets, as credit_balances cascaded with the user', () => {
    expect(foreignKeyOn(wallets, 'userId')).toEqual({ onDelete: 'cascade', target: 'users' });
    expect(foreignKeyOn(wallets, 'orgId')).toEqual({ onDelete: 'cascade', target: 'organizations' });
    expect(foreignKeyOn(wallets, 'parentWalletId')).toEqual({ onDelete: 'no action', target: 'wallets' });
  });

  it('WAL-2 (partial): one personal root per user, one pool per org, one wallet per subject', () => {
    expect(indexNamed(wallets, 'wallets_personal_root_unique')).toEqual({ unique: true, columns: ['userId'], where: PERSONAL_ROOT });
    expect(indexNamed(wallets, 'wallets_org_pool_unique')).toEqual({
      unique: true,
      columns: ['orgId'],
      where: `"ownerType" = 'org' AND "subjectType" IS NULL AND "parentWalletId" IS NULL`,
    });
    expect(indexNamed(wallets, 'wallets_subject_unique')).toEqual({
      unique: true,
      columns: ['subjectType', 'subjectId'],
      where: '"subjectId" IS NOT NULL',
    });
  });

  it('WAL-2 (partial): the personal-root predicate and arbiter restate exactly the unique index predicate', () => {
    expect(dialect.sqlToQuery(PERSONAL_ROOT_WALLET_ARBITER.where).sql).toBe(PERSONAL_ROOT);
    expect(PERSONAL_ROOT_WALLET_ARBITER.target).toBe(wallets.userId);
    const of = dialect.sqlToQuery(personalRootWalletOf('u_1'));
    expect(of.sql).toBe(
      '("wallets"."userId" = $1 and ("wallets"."ownerType" = $2 and "wallets"."subjectType" is null and "wallets"."parentWalletId" is null))',
    );
    expect(of.params).toEqual(['u_1', 'user']);
    expect(dialect.sqlToQuery(isPersonalRootWallet()).sql).toBe(
      '("wallets"."ownerType" = $1 and "wallets"."subjectType" is null and "wallets"."parentWalletId" is null)',
    );
  });
});

describe('walletId on the ledger, holds and AI usage log', () => {
  it('WAL-5 (partial): every ledger and hold row names its wallet (NOT NULL, cascades with the wallet)', () => {
    expect(getTableColumns(creditLedger).walletId.notNull).toBe(true);
    expect(getTableColumns(creditHolds).walletId.notNull).toBe(true);
    expect(foreignKeyOn(creditLedger, 'walletId')).toEqual({ onDelete: 'cascade', target: 'wallets' });
    expect(foreignKeyOn(creditHolds, 'walletId')).toEqual({ onDelete: 'cascade', target: 'wallets' });
    expect(indexNamed(creditLedger, 'credit_ledger_wallet_idx').columns).toEqual(['walletId', 'createdAt']);
    expect(indexNamed(creditHolds, 'credit_holds_wallet_idx').columns).toEqual(['walletId']);
  });

  it('WAL-5 (partial): an AI usage row can record the wallet charged, as a soft link that never blocks a wallet delete', () => {
    const column = getTableConfig(aiUsageLogs).columns.find((c) => c.name === 'wallet_id');
    expect(column?.notNull).toBe(false);
    expect(getTableConfig(aiUsageLogs).foreignKeys.some((f) => f.reference().columns.some((c) => c.name === 'wallet_id'))).toBe(false);
  });
});

describe('wallet_consumer_caps', () => {
  it('WAL-7 (partial): is keyed (walletId, consumerKey), caps are nullable whole cents, and it cascades with the wallet', () => {
    const config = getTableConfig(walletConsumerCaps);
    expect(config.primaryKeys.map((pk) => pk.columns.map((c) => c.name))).toEqual([['walletId', 'consumerKey']]);
    const columns = getTableColumns(walletConsumerCaps);
    expect(columns.dailyCapCents.notNull).toBe(false);
    expect(columns.monthlyCapCents.notNull).toBe(false);
    expect(columns.dailyCapCents.columnType).toBe('PgInteger');
    expect(foreignKeyOn(walletConsumerCaps, 'walletId')).toEqual({ onDelete: 'cascade', target: 'wallets' });
    expect(checkNames(walletConsumerCaps)).toEqual([
      'wallet_consumer_caps_consumer_key_nonempty',
      'wallet_consumer_caps_daily_nonneg',
      'wallet_consumer_caps_monthly_nonneg',
    ]);
  });
});

describe('the stored spend source', () => {
  it('SPEND-3 (partial): a wallet carries a nullable default spend source, checked against the three source kinds and refused on an org pool', () => {
    const column = getTableColumns(wallets).defaultSpendSource;
    // NULL means "no default set": nothing is preselected from this row.
    expect(column.notNull).toBe(false);
    expect(column.default).toBeUndefined();
    expect(SPEND_SOURCE_KINDS).toEqual(['drive_wallet', 'seat_allowance', 'own_credits']);
    const check = getTableConfig(wallets).checks.find((c) => c.name === 'wallets_default_spend_source_valid');
    expect(check && dialect.sqlToQuery(check.value).sql).toBe(
      `"wallets"."defaultSpendSource" IS NULL OR ("wallets"."defaultSpendSource" IN ('drive_wallet', 'seat_allowance', 'own_credits') AND NOT ("wallets"."ownerType" = 'org' AND "wallets"."subjectType" IS NULL))`,
    );
  });

  it('SPEND-3 (partial): a conversation records the wallet chosen for it, nullable and with no foreign key', () => {
    const column = getTableColumns(conversations).chosenWalletId;
    // NULL means "nothing chosen for this conversation": the gate preselects or refuses, never guesses.
    expect(column.notNull).toBe(false);
    expect(column.default).toBeUndefined();
    // No FK on purpose: a deleted wallet must leave the id behind so the gate refuses it,
    // where ON DELETE SET NULL would silently move the conversation to a preselected source.
    expect(getTableConfig(conversations).foreignKeys.some((f) => f.reference().columns.some((c) => c.name === 'chosenWalletId'))).toBe(false);
  });
});

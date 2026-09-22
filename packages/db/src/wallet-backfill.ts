import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * The X-5 wallets backfill, runnable outside the migrator.
 *
 * Migration 0301 IS the backfill: it gives every credit_ledger and credit_holds row its
 * owner's personal root wallet, in the same migrate invocation as the NOT NULL (0302)
 * that depends on it. This runner executes the exact statements of that file (read from
 * disk, never a copy) inside one transaction, measures the money and the row counts
 * before and after, and then:
 *   - with `dryRun`, ROLLS BACK, so nothing is written, and reports what would change;
 *   - otherwise COMMITS, after refusing (rolling back) if any money moved.
 * On a database already migrated through 0301 it is a verifier: every count in the
 * report comes back unchanged, which is what idempotent means here.
 *
 * Run it through `scripts/backfill-wallets.ts`.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../drizzle');
const BACKFILL_MIGRATION_PREFIX = '0301_';
const BREAKPOINT = '--> statement-breakpoint';

/** The statements of migration 0301, in order, exactly as the migrator runs them. */
export function walletBackfillStatements(migrationsDir: string = MIGRATIONS_DIR): string[] {
  const file = readdirSync(migrationsDir).find(
    (name) => name.startsWith(BACKFILL_MIGRATION_PREFIX) && name.endsWith('.sql'),
  );
  if (!file) throw new Error(`wallet backfill migration ${BACKFILL_MIGRATION_PREFIX}*.sql not found in ${migrationsDir}`);
  return readFileSync(path.join(migrationsDir, file), 'utf8')
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** A connected client this runner may BEGIN and COMMIT/ROLLBACK on (a pg Client or PoolClient). */
export interface BackfillClient {
  query(text: string): Promise<{ rows: unknown[] }>;
}

export interface WalletBackfillCounts {
  wallets: number;
  personalRootWallets: number;
  ledgerRows: number;
  holdRows: number;
  ledgerMissingWallet: number;
  holdsMissingWallet: number;
  /** Across every wallet, whole cents. The backfill must never change any of these. */
  monthlyRemainingCents: number;
  topupRemainingCents: number;
  debtCents: number;
  pendingMillicents: number;
}

export interface WalletBackfillReport {
  dryRun: boolean;
  committed: boolean;
  before: WalletBackfillCounts;
  after: WalletBackfillCounts;
  walletsCreated: number;
  ledgerRowsAssigned: number;
  holdRowsAssigned: number;
}

const PERSONAL_ROOT = `"ownerType" = 'user' AND "subjectType" IS NULL AND "parentWalletId" IS NULL`;

// Sums are cast to text and parsed: a bigint sum overflows a JS number only far past any
// real balance, but numeric-as-string keeps the driver from guessing.
const COUNTS_SQL = `
  SELECT
    (SELECT count(*) FROM "wallets")::text AS wallets,
    (SELECT count(*) FROM "wallets" WHERE ${PERSONAL_ROOT})::text AS "personalRootWallets",
    (SELECT count(*) FROM "credit_ledger")::text AS "ledgerRows",
    (SELECT count(*) FROM "credit_holds")::text AS "holdRows",
    (SELECT count(*) FROM "credit_ledger" WHERE "walletId" IS NULL)::text AS "ledgerMissingWallet",
    (SELECT count(*) FROM "credit_holds" WHERE "walletId" IS NULL)::text AS "holdsMissingWallet",
    (SELECT coalesce(sum("monthlyRemainingCents"), 0) FROM "wallets")::text AS "monthlyRemainingCents",
    (SELECT coalesce(sum("topupRemainingCents"), 0) FROM "wallets")::text AS "topupRemainingCents",
    (SELECT coalesce(sum("debtCents"), 0) FROM "wallets")::text AS "debtCents",
    (SELECT coalesce(sum("pendingMillicents"), 0) FROM "wallets")::text AS "pendingMillicents"
`;

async function readCounts(client: BackfillClient): Promise<WalletBackfillCounts> {
  const { rows } = await client.query(COUNTS_SQL);
  const row = rows[0] as Record<keyof WalletBackfillCounts, string>;
  const n = (key: keyof WalletBackfillCounts): number => Number(row[key]);
  return {
    wallets: n('wallets'),
    personalRootWallets: n('personalRootWallets'),
    ledgerRows: n('ledgerRows'),
    holdRows: n('holdRows'),
    ledgerMissingWallet: n('ledgerMissingWallet'),
    holdsMissingWallet: n('holdsMissingWallet'),
    monthlyRemainingCents: n('monthlyRemainingCents'),
    topupRemainingCents: n('topupRemainingCents'),
    debtCents: n('debtCents'),
    pendingMillicents: n('pendingMillicents'),
  };
}

const MONEY_KEYS = ['monthlyRemainingCents', 'topupRemainingCents', 'debtCents', 'pendingMillicents'] as const;

/** The money columns that changed between two counts; the backfill must leave this empty. */
export function moneyDrift(before: WalletBackfillCounts, after: WalletBackfillCounts): string[] {
  return MONEY_KEYS.filter((key) => before[key] !== after[key]).map(
    (key) => `${key}: ${before[key]} -> ${after[key]}`,
  );
}

export async function runWalletBackfill(
  client: BackfillClient,
  options: { dryRun: boolean; statements?: string[] },
): Promise<WalletBackfillReport> {
  const statements = options.statements ?? walletBackfillStatements();
  await client.query('BEGIN');
  try {
    const before = await readCounts(client);
    for (const statement of statements) {
      await client.query(statement);
    }
    const after = await readCounts(client);

    const drift = moneyDrift(before, after);
    if (drift.length > 0) {
      throw new Error(`wallet backfill would move money; rolled back (${drift.join(', ')})`);
    }

    if (options.dryRun) {
      await client.query('ROLLBACK');
    } else {
      await client.query('COMMIT');
    }
    return {
      dryRun: options.dryRun,
      committed: !options.dryRun,
      before,
      after,
      walletsCreated: after.wallets - before.wallets,
      ledgerRowsAssigned: before.ledgerMissingWallet - after.ledgerMissingWallet,
      holdRowsAssigned: before.holdsMissingWallet - after.holdsMissingWallet,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

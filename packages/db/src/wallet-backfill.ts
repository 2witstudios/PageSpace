import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * The X-5 wallets backfill, runnable outside the migrator.
 *
 * Migration 0315 IS the backfill: it gives every credit_ledger and credit_holds row its
 * owner's personal root wallet, in the same migrate invocation as the NOT NULL (0316)
 * that depends on it. This runner executes the exact statements of that file (read from
 * disk, never a copy) inside one transaction, measures the money and the row counts
 * before and after, and then:
 *   - with `dryRun`, ROLLS BACK, so nothing is written, and reports what would change;
 *   - otherwise COMMITS, after refusing (rolling back) if any money moved.
 * On a database already migrated through 0315 it is a verifier: every count in the
 * report comes back unchanged, which is what idempotent means here.
 *
 * Production is at 0309 until the deploy, so a rehearsal there cannot run 0315 alone:
 * `rehearseWalletMigration` runs the WHOLE chain, 0310 through 0316, inside one
 * transaction and always rolls it back (Postgres DDL is transactional).
 *
 * The chain was renumbered twice, each time master's migrations landed first: after
 * master's 0297/0298 (agent accounts) and again after master's 0308/0309 (the GUEST member
 * role). The SQL files were renamed with their bytes unchanged (the migrator keys on a hash
 * of the content, so a rename never re-runs one). Comments INSIDE those files still use the
 * original numbers: 0297 -> 0310, 0298 -> 0311, 0299 -> 0312, 0300 -> 0313, 0300_1 -> 0314,
 * 0301 -> 0315, 0302 -> 0316.
 *
 * Run it through `scripts/backfill-wallets.ts`.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../drizzle');
const BACKFILL_MIGRATION_PREFIX = '0315_';
const BREAKPOINT = '--> statement-breakpoint';

/** The statements of the migration file starting with `prefix`, in order, exactly as the migrator runs them. */
function migrationStatements(prefix: string, migrationsDir: string): string[] {
  const file = readdirSync(migrationsDir).find((name) => name.startsWith(prefix) && name.endsWith('.sql'));
  if (!file) throw new Error(`wallet migration ${prefix}*.sql not found in ${migrationsDir}`);
  return readFileSync(path.join(migrationsDir, file), 'utf8')
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** The statements of migration 0315, in order, exactly as the migrator runs them. */
export function walletBackfillStatements(migrationsDir: string = MIGRATIONS_DIR): string[] {
  return migrationStatements(BACKFILL_MIGRATION_PREFIX, migrationsDir);
}

/** The file-name prefixes of everything the deploy runs on top of production's 0309: the org
 * schema (0310; 0313 adds a foreign key to its `organizations` table) and the X-5 chain,
 * 0311 through 0316, with the lock-and-require (0314) before the backfill (0315). The journal,
 * not the name, sets the order. */
const WALLET_CHAIN_PREFIXES = ['0310_', '0311_', '0312_', '0313_', '0314_', '0315_', '0316_'] as const;

/** Every X-5 chain migration, in the order the migrator applies them: journal order, not file order. */
function walletChainStatements(migrationsDir: string): string[] {
  const journal = JSON.parse(readFileSync(path.join(migrationsDir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  const chain = journal.entries
    .map((entry) => entry.tag)
    .filter((tag) => WALLET_CHAIN_PREFIXES.some((prefix) => tag.startsWith(prefix)));
  return chain.flatMap((tag) => migrationStatements(`${tag}.sql`, migrationsDir));
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

/** The balances as they stand at 0309, read from credit_balances. Whole cents. */
export interface PreMigrationCounts {
  balanceRows: number;
  ledgerRows: number;
  holdRows: number;
  monthlyRemainingCents: number;
  topupRemainingCents: number;
  debtCents: number;
  pendingMillicents: number;
}

export interface WalletMigrationRehearsal {
  /** Always true: a rehearsal never commits. */
  rolledBack: true;
  before: PreMigrationCounts;
  after: WalletBackfillCounts;
  /** Zero-balance personal wallets 0315 would create for users with ledger or hold rows but no balance row. */
  zeroWalletsCreated: number;
  /** Balance totals that would change; the deploy must leave this empty. */
  drift: string[];
}

const PRE_COUNTS_SQL = `
  SELECT
    (SELECT count(*) FROM "credit_balances")::text AS "balanceRows",
    (SELECT count(*) FROM "credit_ledger")::text AS "ledgerRows",
    (SELECT count(*) FROM "credit_holds")::text AS "holdRows",
    (SELECT coalesce(sum("monthlyRemainingCents"), 0) FROM "credit_balances")::text AS "monthlyRemainingCents",
    (SELECT coalesce(sum("topupRemainingCents"), 0) FROM "credit_balances")::text AS "topupRemainingCents",
    (SELECT coalesce(sum("debtCents"), 0) FROM "credit_balances")::text AS "debtCents",
    (SELECT coalesce(sum("pendingMillicents"), 0) FROM "credit_balances")::text AS "pendingMillicents"
`;

/**
 * Rehearse the X-5 deploy against a database still at 0309 (production before the deploy,
 * or a restored snapshot of it): run 0310–0316 in ONE transaction, measure, and ROLL BACK.
 * Refuses a database that is not at 0309, rather than reporting "nothing to do".
 *
 * It holds the locks the real migration takes (the rename is ACCESS EXCLUSIVE on the
 * balance table) until it rolls back, so live traffic waits for it: rehearse against a
 * restored snapshot, not the live primary. `lock_timeout` stops it queueing behind live
 * writers indefinitely.
 */
export async function rehearseWalletMigration(
  client: BackfillClient,
  migrationsDir: string = MIGRATIONS_DIR,
): Promise<WalletMigrationRehearsal> {
  const statements = walletChainStatements(migrationsDir);
  const { rows: stateRows } = await client.query(
    `SELECT to_regclass('public.credit_balances') IS NOT NULL AS "hasBalances", to_regclass('public.wallets') IS NOT NULL AS "hasWallets", to_regclass('public.organizations') IS NOT NULL AS "hasOrganizations"`,
  );
  const state = stateRows[0] as { hasBalances: boolean; hasWallets: boolean; hasOrganizations: boolean };
  if (!state.hasBalances || state.hasWallets || state.hasOrganizations) {
    throw new Error('database is not at 0309 (credit_balances present, wallets and organizations absent); run the dry run of the backfill (0315) instead');
  }

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    const { rows } = await client.query(PRE_COUNTS_SQL);
    const pre = rows[0] as Record<keyof PreMigrationCounts, string>;
    const before: PreMigrationCounts = {
      balanceRows: Number(pre.balanceRows),
      ledgerRows: Number(pre.ledgerRows),
      holdRows: Number(pre.holdRows),
      monthlyRemainingCents: Number(pre.monthlyRemainingCents),
      topupRemainingCents: Number(pre.topupRemainingCents),
      debtCents: Number(pre.debtCents),
      pendingMillicents: Number(pre.pendingMillicents),
    };
    for (const statement of statements) {
      await client.query(statement);
    }
    const after = await readCounts(client);
    return {
      rolledBack: true,
      before,
      after,
      zeroWalletsCreated: after.wallets - before.balanceRows,
      drift: MONEY_KEYS.filter((key) => before[key] !== after[key]).map((key) => `${key}: ${before[key]} -> ${after[key]}`),
    };
  } finally {
    await client.query('ROLLBACK');
  }
}

/**
 * Migrations 0298–0302 — credit_balances BECOMES the wallets table (Spec X-5, WAL-1,
 * WAL-2, WAL-5). THIS IS LIVE MONEY: credit_balances holds every user's real balance.
 *
 *   0298 (generated) renames credit_balances to wallets, in place.
 *   0299 (custom)    drops the userId primary key drizzle-kit cannot name.
 *   0300 (generated) adds id, owner, subject, parent, status, caps table, walletId columns.
 *   0301 (custom)    backfills walletId on every credit_ledger and credit_holds row.
 *   0302 (generated) makes those walletId columns NOT NULL.
 *
 * What is pinned, each against a real Postgres migrated from 0297 (the schema as it
 * stands before this change), seeded with balances, ledger rows and holds:
 *   (a) every user's personal root wallet holds exactly their old balance, to the cent,
 *       bucket by bucket, and so the same spendable;
 *   (b) the sum of every balance is unchanged;
 *   (c) one personal root wallet per former credit_balances row, no duplicates, and the
 *       only extra wallets are zero-balance ones for users that had ledger/hold rows but
 *       no balance row;
 *   (d) every ledger and hold row carries its owner's personal root wallet;
 *   (e) running the backfill again changes nothing;
 *   (f) the --dry-run backfill writes nothing.
 *
 * Two layers, like the other migration suites here: static invariants of the SQL (no
 * database), and live behaviour whenever DATABASE_URL is set. The live layer migrates a
 * TEMPLATE database to 0297 and copies it per scenario; the app's database is never
 * touched, and every database it creates is dropped in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { runMigrations, type RunnableMigration } from '../migration-runner';
import { runWalletBackfill, walletBackfillStatements, moneyDrift, type BackfillClient } from '../wallet-backfill';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');

function readMigration(idx: number): { file: string; sql: string; code: string } {
  const prefix = String(idx).padStart(4, '0');
  const file = readdirSync(MIGRATIONS_DIR).find((f) => new RegExp(`^${prefix}_.*\\.sql$`).test(f));
  if (!file) throw new Error(`no migration ${prefix}_*.sql`);
  const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  // Line and block comments stripped, so assertions never match prose.
  const code = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return { file, sql, code };
}

/** The leading verb of every statement of a raw migration, e.g. `ALTER TABLE`, `CREATE INDEX`. */
function statementVerbs(rawSql: string): string[] {
  return rawSql
    .split('--> statement-breakpoint')
    .map((statement) =>
      statement
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter(Boolean)
    .map((statement) => statement.split(/\s+/).slice(0, 2).join(' ').toUpperCase());
}

const rename = readMigration(298);
const dropPk = readMigration(299);
const expand = readMigration(300);
const backfill = readMigration(301);
const required = readMigration(302);

const journal = JSON.parse(
  readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
) as { entries: Array<{ idx: number; tag: string }> };

describe('drizzle/0298–0302 — credit_balances becomes wallets (static)', () => {
  it('X-5 (partial): the five migrations are journal entries 298–302, in order', () => {
    for (const [idx, m] of [[298, rename], [299, dropPk], [300, expand], [301, backfill], [302, required]] as const) {
      expect(journal.entries.find((e) => e.idx === idx)?.tag).toBe(path.basename(m.file, '.sql'));
    }
  });

  it('X-5 (partial): 0298 renames credit_balances in place and creates, copies or deletes nothing', () => {
    expect(rename.code).toContain('ALTER TABLE "credit_balances" RENAME TO "wallets"');
    // Only ALTER TABLE statements; the constraints it touches are dropped and re-added by name.
    expect(new Set(statementVerbs(rename.sql))).toEqual(new Set(['ALTER TABLE']));
    expect(rename.code).not.toMatch(/DROP COLUMN|DROP TABLE/i);
  });

  it('X-5 (partial): 0299 drops only the old primary key constraint, re-runnably', () => {
    expect(dropPk.code.trim()).toBe('ALTER TABLE "wallets" DROP CONSTRAINT IF EXISTS "credit_balances_pkey";');
  });

  it('X-5 (partial): 0300 never drops a money column or rewrites a balance', () => {
    expect(new Set(statementVerbs(expand.sql))).toEqual(new Set(['ALTER TABLE', 'CREATE TABLE', 'CREATE UNIQUE', 'CREATE INDEX']));
    expect(expand.code).not.toMatch(/DROP COLUMN|DROP TABLE|TRUNCATE/i);
    expect(expand.code).toContain('ALTER TABLE "credit_ledger" ADD COLUMN "walletId" text;');
    expect(expand.code).toContain('ALTER TABLE "credit_holds" ADD COLUMN "walletId" text;');
  });

  it('X-5 (partial): 0301 only fills NULL walletIds, never deletes, and guards before 0302', () => {
    expect(statementVerbs(backfill.sql)).toEqual(['INSERT INTO', 'UPDATE "CREDIT_LEDGER"', 'UPDATE "CREDIT_HOLDS"', 'DO $$']);
    expect(backfill.code).not.toMatch(/DELETE|TRUNCATE|DROP/i);
    // Every UPDATE is scoped to unassigned rows, so a re-run is a no-op.
    const updates = backfill.code.match(/UPDATE "credit_(ledger|holds)"[\s\S]*?;/g) ?? [];
    expect(updates).toHaveLength(2);
    for (const update of updates) expect(update).toMatch(/"walletId" IS NULL/);
    // The only wallet it inserts is a zero one, and only when none exists.
    expect(backfill.code).toMatch(/INSERT INTO "wallets" \("ownerType", "userId"\)/);
    expect(backfill.code).toContain('DO NOTHING');
    expect(backfill.code).toContain('RAISE EXCEPTION');
  });

  it('X-5 (partial): 0302 only makes walletId required on ledger and holds', () => {
    expect(required.code.replace(/--> statement-breakpoint/g, '').trim().split(/;\s*/).filter(Boolean)).toEqual([
      'ALTER TABLE "credit_holds" ALTER COLUMN "walletId" SET NOT NULL',
      'ALTER TABLE "credit_ledger" ALTER COLUMN "walletId" SET NOT NULL',
    ]);
  });

  it('X-5 (partial): the backfill runner executes exactly the statements of 0301', () => {
    const statements = walletBackfillStatements(MIGRATIONS_DIR);
    expect(statements.join('\n--> statement-breakpoint\n')).toBe(
      backfill.sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean).join('\n--> statement-breakpoint\n'),
    );
    expect(statements).toHaveLength(4);
  });

  it('X-5 (partial): moneyDrift names every balance column that changed and nothing else', () => {
    const counts = {
      wallets: 2, personalRootWallets: 2, ledgerRows: 1, holdRows: 1, ledgerMissingWallet: 0, holdsMissingWallet: 0,
      monthlyRemainingCents: 100, topupRemainingCents: 50, debtCents: 7, pendingMillicents: 400,
    };
    expect(moneyDrift(counts, { ...counts, wallets: 3, ledgerMissingWallet: 9 })).toEqual([]);
    expect(moneyDrift(counts, { ...counts, topupRemainingCents: 51, pendingMillicents: 0 })).toEqual([
      'topupRemainingCents: 50 -> 51',
      'pendingMillicents: 400 -> 0',
    ]);
  });
});

// ───────────────────────────── live behaviour ──────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const describeLive = DATABASE_URL ? describe : describe.skip;

const allMigrations: RunnableMigration[] = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
/** Everything BEFORE 0298 (… 0297): the schema with credit_balances. */
const baseMigrations = allMigrations.slice(0, 298);
/** Through 0300: the columns exist but the backfill has not run (the dry-run scenario). */
const throughExpand = allMigrations.slice(0, 301);
/** Through 0302 and no further — bounded by index so a later migration never joins in. */
const throughThisChange = allMigrations.slice(0, 303);

const JOURNAL = { migrationsSchema: 'drizzle', migrationsTable: '__drizzle_migrations' };

function urlForDatabase(name: string): string {
  const parsed = new URL(DATABASE_URL as string);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

const suffix = `${process.pid}_${Date.now().toString(36)}`;
const TEMPLATE_DB = `psx_wallets_tmpl_${suffix}`;
const createdDatabases: string[] = [];
let adminPool: Pool;

interface Scenario {
  pool: Pool;
  notices: string[];
  migrate: (migrations: RunnableMigration[]) => Promise<void>;
  query: <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<T[]>;
}

async function openScenario(name: string): Promise<Scenario> {
  const dbName = `psx_wallets_${name}_${suffix}`;
  await adminPool.query(`CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB}"`);
  createdDatabases.push(dbName);
  const notices: string[] = [];
  const pool = new Pool({ connectionString: urlForDatabase(dbName), max: 1 });
  pool.on('error', () => {});
  pool.on('connect', (client) => {
    client.on('notice', (n) => notices.push(`${n.severity}: ${n.message ?? ''}`));
  });
  return {
    pool,
    notices,
    migrate: (migrations) => runMigrations(drizzle(pool), migrations, JOURNAL),
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]) =>
      (await pool.query(text, values)).rows as T[],
  };
}

/** One former credit_balances row. A type alias, so it satisfies Record<string, unknown>. */
type Balance = {
  userId: string;
  monthlyRemainingCents: number;
  monthlyAllowanceCents: number;
  topupRemainingCents: number;
  debtCents: number;
  pendingMillicents: number;
  monthlyPeriodStart: string | null;
  monthlyPeriodEnd: string | null;
};

const BALANCES: Balance[] = [
  // Paid, rolled over past its allowance.
  { userId: 'u_paid', monthlyRemainingCents: 4250, monthlyAllowanceCents: 2000, topupRemainingCents: 1999, debtCents: 0, pendingMillicents: 731, monthlyPeriodStart: '2026-09-01T00:00:00Z', monthlyPeriodEnd: '2026-10-01T00:00:00Z' },
  // Free, part spent.
  { userId: 'u_free', monthlyRemainingCents: 37, monthlyAllowanceCents: 100, topupRemainingCents: 0, debtCents: 0, pendingMillicents: 0, monthlyPeriodStart: '2026-08-15T12:30:00Z', monthlyPeriodEnd: '2026-09-15T12:30:00Z' },
  // In debt: net spendable is negative and must stay exactly that negative.
  { userId: 'u_debt', monthlyRemainingCents: 0, monthlyAllowanceCents: 1500, topupRemainingCents: 12, debtCents: 845, pendingMillicents: 999, monthlyPeriodStart: '2026-09-02T00:00:00Z', monthlyPeriodEnd: '2026-10-02T00:00:00Z' },
  // A bare row a top-up created before the first AI call: no period stamped.
  { userId: 'u_bare', monthlyRemainingCents: 0, monthlyAllowanceCents: 0, topupRemainingCents: 500, debtCents: 0, pendingMillicents: 0, monthlyPeriodStart: null, monthlyPeriodEnd: null },
  // Everything zero.
  { userId: 'u_zero', monthlyRemainingCents: 0, monthlyAllowanceCents: 0, topupRemainingCents: 0, debtCents: 0, pendingMillicents: 0, monthlyPeriodStart: null, monthlyPeriodEnd: null },
];

/** Has ledger and hold rows but never had a balance row (a billing-off deployment's hold). */
const ORPHAN_USER = 'u_orphan';
/** Has nothing at all: must not gain a wallet. */
const BYSTANDER_USER = 'u_bystander';

/**
 * The 0297 corpus: users, balances, ledger rows and holds, written as the old code wrote them.
 * `withOrphan: false` leaves out the user whose ledger and holds have no balance row, so the
 * wallet count after must EQUAL the credit_balances count before.
 */
async function seedCorpus(s: Scenario, { withOrphan = true }: { withOrphan?: boolean } = {}): Promise<void> {
  const userIds = [...BALANCES.map((b) => b.userId), ORPHAN_USER, BYSTANDER_USER];
  for (const id of userIds) {
    await s.query(
      `INSERT INTO "users" ("id", "name", "email", "createdAt", "updatedAt") VALUES ($1, $1, $2, now(), now())`,
      [id, `${id}@example.test`],
    );
  }
  for (const b of BALANCES) {
    await s.query(
      `INSERT INTO "credit_balances" ("userId", "monthlyRemainingCents", "monthlyAllowanceCents", "topupRemainingCents",
         "debtCents", "pendingMillicents", "monthlyPeriodStart", "monthlyPeriodEnd")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [b.userId, b.monthlyRemainingCents, b.monthlyAllowanceCents, b.topupRemainingCents, b.debtCents,
        b.pendingMillicents, b.monthlyPeriodStart, b.monthlyPeriodEnd],
    );
  }
  let n = 0;
  const ledger = async (userId: string, entryType: string, amountCents: number, extra: { stripeRef?: string; aiUsageLogId?: string } = {}) => {
    n += 1;
    await s.query(
      `INSERT INTO "credit_ledger" ("id", "userId", "entryType", "bucket", "amountCents", "stripeRef", "aiUsageLogId", "consumeStatus")
       VALUES ($1, $2, $3, 'monthly', $4, $5, $6, 'applied')`,
      [`l_${n}`, userId, entryType, amountCents, extra.stripeRef ?? null, extra.aiUsageLogId ?? null],
    );
  };
  await ledger('u_paid', 'monthly_grant', 2000, { stripeRef: 'in_paid_1' });
  await ledger('u_paid', 'topup_purchase', 2500, { stripeRef: 'cs_paid_1' });
  await ledger('u_paid', 'usage', -250, { aiUsageLogId: 'log_paid_1' });
  await ledger('u_free', 'monthly_grant', 100, { stripeRef: 'free-init-u_free' });
  await ledger('u_free', 'usage', -63, { aiUsageLogId: 'log_free_1' });
  await ledger('u_debt', 'usage', -1500, { aiUsageLogId: 'log_debt_1' });
  await ledger('u_debt', 'adjustment', -845, { aiUsageLogId: 'log_debt_1' });
  await ledger('u_bare', 'topup_purchase', 500, { stripeRef: 'cs_bare_1' });
  if (withOrphan) await ledger(ORPHAN_USER, 'usage', 0, { aiUsageLogId: 'log_orphan_1' });

  const hold = async (id: string, userId: string, estCents: number) => {
    await s.query(
      `INSERT INTO "credit_holds" ("id", "userId", "estCents", "expiresAt") VALUES ($1, $2, $3, now() + interval '5 minutes')`,
      [id, userId, estCents],
    );
  };
  await hold('h_paid_1', 'u_paid', 5);
  await hold('h_paid_2', 'u_paid', 5);
  await hold('h_free_1', 'u_free', 1);
  if (withOrphan) await hold('h_orphan_1', ORPHAN_USER, 3);
}

async function readBalancesBefore(s: Scenario): Promise<Balance[]> {
  return s.query<Balance>(
    `SELECT "userId", "monthlyRemainingCents", "monthlyAllowanceCents", "topupRemainingCents", "debtCents",
            "pendingMillicents", "monthlyPeriodStart", "monthlyPeriodEnd"
       FROM "credit_balances" ORDER BY "userId"`,
  );
}

async function readPersonalRootWallets(s: Scenario): Promise<Array<Balance & { id: string }>> {
  return s.query<Balance & { id: string }>(
    `SELECT "id", "userId", "monthlyRemainingCents", "monthlyAllowanceCents", "topupRemainingCents", "debtCents",
            "pendingMillicents", "monthlyPeriodStart", "monthlyPeriodEnd"
       FROM "wallets"
      WHERE "ownerType" = 'user' AND "subjectType" IS NULL AND "parentWalletId" IS NULL
      ORDER BY "userId"`,
  );
}

const spendable = (b: Balance): number => b.monthlyRemainingCents + b.topupRemainingCents - b.debtCents;

/** Every wallet, ledger and hold row, for a byte-for-byte before/after comparison. */
async function fullSnapshot(s: Scenario): Promise<string> {
  const wallets = await s.query(`SELECT * FROM "wallets" ORDER BY "id"`);
  const ledger = await s.query(`SELECT * FROM "credit_ledger" ORDER BY "id"`);
  const holds = await s.query(`SELECT * FROM "credit_holds" ORDER BY "id"`);
  return JSON.stringify({ wallets, ledger, holds });
}

async function withClient<T>(pool: Pool, fn: (client: BackfillClient) => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

describeLive('0298–0302 against a real Postgres', () => {
  beforeAll(async () => {
    adminPool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    adminPool.on('error', () => {});
    await adminPool.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
    createdDatabases.push(TEMPLATE_DB);
    const templatePool = new Pool({ connectionString: urlForDatabase(TEMPLATE_DB), max: 1 });
    templatePool.on('error', () => {});
    try {
      await runMigrations(drizzle(templatePool), baseMigrations, JOURNAL);
    } finally {
      await templatePool.end();
    }
  }, 600_000);

  afterAll(async () => {
    if (!adminPool) return;
    for (const name of [...createdDatabases].reverse()) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    }
    await adminPool.end();
  }, 120_000);

  it('pins the base: 0297 is the last migration before this change', () => {
    expect(allMigrations.length).toBe(journal.entries.length);
    expect(journal.entries[297]?.tag).toBe('0297_aromatic_smiling_tiger');
    expect(throughThisChange.length - baseMigrations.length).toBe(5);
  });

  it('X-5: credit_balances becomes wallets in place — dry-run writes nothing, row counts and every balance and the sum equal to the cent, every ledger and hold row on its owner\'s root, a re-run changes nothing', async () => {
    const s = await openScenario('x5');
    try {
      await seedCorpus(s, { withOrphan: false });
      const before = await readBalancesBefore(s);
      expect(before).toHaveLength(BALANCES.length);
      const ledgerBefore = await s.query<{ id: string; userId: string }>(`SELECT "id", "userId" FROM "credit_ledger" ORDER BY "id"`);
      const holdsBefore = await s.query<{ id: string; userId: string }>(`SELECT "id", "userId" FROM "credit_holds" ORDER BY "id"`);

      // The expand step first, then a DRY RUN of the backfill: it names the work and writes nothing.
      await s.migrate(throughExpand);
      const expanded = await fullSnapshot(s);
      const dry = await withClient(s.pool, (c) => runWalletBackfill(c, { dryRun: true, statements: walletBackfillStatements(MIGRATIONS_DIR) }));
      expect(dry).toMatchObject({ committed: false, walletsCreated: 0, ledgerRowsAssigned: ledgerBefore.length, holdRowsAssigned: holdsBefore.length });
      expect(await fullSnapshot(s)).toBe(expanded);

      // The rest of the chain: the backfill for real, then walletId required.
      await s.migrate(throughThisChange);

      // One balance store: credit_balances no longer exists.
      const gone = await s.query<{ present: boolean }>(`SELECT to_regclass('public.credit_balances') IS NOT NULL AS present`);
      expect(gone[0].present).toBe(false);

      // Row count equality: exactly one personal root wallet per former credit_balances row.
      const counts = await s.query<{ wallets: number; roots: number; distinctUsers: number }>(`
        SELECT (SELECT count(*)::int FROM "wallets") AS wallets,
               (SELECT count(*)::int FROM "wallets" WHERE "ownerType" = 'user' AND "subjectType" IS NULL AND "parentWalletId" IS NULL) AS roots,
               (SELECT count(DISTINCT "userId")::int FROM "wallets") AS "distinctUsers"`);
      expect(counts[0]).toEqual({ wallets: before.length, roots: before.length, distinctUsers: before.length });

      // Every user's balance, bucket by bucket and so spendable, to the cent.
      const after = await readPersonalRootWallets(s);
      expect(after.map(({ id: _id, ...w }) => w)).toEqual(before);
      for (const [i, b] of before.entries()) expect(spendable(after[i])).toBe(spendable(b));

      // Sum of balances equality, bucket by bucket and net.
      const total = (rows: Balance[]) => rows.reduce(
        (acc, r) => ({ monthly: acc.monthly + r.monthlyRemainingCents, topup: acc.topup + r.topupRemainingCents, debt: acc.debt + r.debtCents, pending: acc.pending + r.pendingMillicents, net: acc.net + spendable(r) }),
        { monthly: 0, topup: 0, debt: 0, pending: 0, net: 0 },
      );
      expect(total(after)).toEqual(total(before));

      // Every historical ledger and hold row, and only those, names its owner's personal root wallet.
      const rootOf = new Map(after.map((w) => [w.userId, w.id]));
      const ledgerAfter = await s.query<{ id: string; userId: string; walletId: string }>(`SELECT "id", "userId", "walletId" FROM "credit_ledger" ORDER BY "id"`);
      const holdsAfter = await s.query<{ id: string; userId: string; walletId: string }>(`SELECT "id", "userId", "walletId" FROM "credit_holds" ORDER BY "id"`);
      expect(ledgerAfter.map(({ id, userId }) => ({ id, userId }))).toEqual(ledgerBefore);
      expect(holdsAfter.map(({ id, userId }) => ({ id, userId }))).toEqual(holdsBefore);
      for (const row of [...ledgerAfter, ...holdsAfter]) expect(row.walletId, row.id).toBe(rootOf.get(row.userId));

      // Idempotent: the backfill again, committed, changes nothing at all.
      const migrated = await fullSnapshot(s);
      const again = await withClient(s.pool, (c) => runWalletBackfill(c, { dryRun: false, statements: walletBackfillStatements(MIGRATIONS_DIR) }));
      expect(again).toMatchObject({ committed: true, walletsCreated: 0, ledgerRowsAssigned: 0, holdRowsAssigned: 0 });
      expect(await fullSnapshot(s)).toBe(migrated);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('X-5 (partial) WAL-1 (partial): every balance lands in its personal root wallet to the cent, sums and counts equal', async () => {
    const s = await openScenario('money');
    try {
      await seedCorpus(s);
      const before = await readBalancesBefore(s);
      expect(before).toHaveLength(BALANCES.length);

      await s.migrate(throughThisChange);

      // credit_balances is gone: there is never a second balance store.
      const tables = await s.query<{ present: boolean }>(`SELECT to_regclass('public.credit_balances') IS NOT NULL AS present`);
      expect(tables[0].present).toBe(false);

      const after = await readPersonalRootWallets(s);
      const afterByUser = new Map(after.map((w) => [w.userId, w]));

      // (a) per user, bucket by bucket, to the cent — and so the same spendable.
      for (const b of before) {
        const w = afterByUser.get(b.userId);
        expect(w, b.userId).toBeDefined();
        const { id: _id, ...wallet } = w as Balance & { id: string };
        expect(wallet).toEqual(b);
        expect(spendable(wallet)).toBe(spendable(b));
      }

      // (b) the sum of every balance before equals the sum after, bucket by bucket.
      const sum = (rows: Balance[], key: keyof Balance) => rows.reduce((acc, r) => acc + Number(r[key]), 0);
      for (const key of ['monthlyRemainingCents', 'monthlyAllowanceCents', 'topupRemainingCents', 'debtCents', 'pendingMillicents'] as const) {
        expect(sum(after, key), key).toBe(sum(before, key));
      }
      expect(after.reduce((acc, w) => acc + spendable(w), 0)).toBe(before.reduce((acc, b) => acc + spendable(b), 0));

      // (c) one personal root wallet per former row, no duplicates; the ONLY extra wallet
      // is a zero one for the user whose ledger/holds had no balance row.
      const formerUsers = before.map((b) => b.userId);
      expect(after.filter((w) => formerUsers.includes(w.userId))).toHaveLength(before.length);
      const dupes = await s.query(`SELECT "userId" FROM "wallets" GROUP BY "userId" HAVING count(*) > 1`);
      expect(dupes).toEqual([]);
      const all = await s.query<{ userId: string }>(`SELECT "userId" FROM "wallets" ORDER BY "userId"`);
      expect(all.map((r) => r.userId)).toEqual([...formerUsers, ORPHAN_USER].sort());
      const orphan = afterByUser.get(ORPHAN_USER);
      expect(orphan && spendable(orphan)).toBe(0);
      expect(orphan?.pendingMillicents).toBe(0);
      expect(afterByUser.has(BYSTANDER_USER)).toBe(false);

      // Every migrated wallet is a personal root: user-owned, active, no subject, no parent.
      const shapes = await s.query(
        `SELECT DISTINCT "ownerType", "orgId", "subjectType", "subjectId", "parentWalletId", "status", "spentCents"
           FROM "wallets"`,
      );
      expect(shapes).toEqual([
        { ownerType: 'user', orgId: null, subjectType: null, subjectId: null, parentWalletId: null, status: 'active', spentCents: 0 },
      ]);
      // Ids are cuid-shaped (a letter, then lowercase alphanumerics) and distinct.
      const ids = await s.query<{ id: string }>(`SELECT "id" FROM "wallets"`);
      for (const { id } of ids) expect(id).toMatch(/^[a-z][0-9a-z]{23}$/);
      expect(new Set(ids.map((r) => r.id)).size).toBe(ids.length);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('X-5 (partial) WAL-5 (partial): every ledger and hold row carries its owner\'s personal root wallet', async () => {
    const s = await openScenario('walletids');
    try {
      await seedCorpus(s);
      await s.migrate(throughThisChange);

      // (d) no row without a wallet, and every historical row points at its owner's root.
      const mismatched = await s.query(`
        SELECT 'ledger' AS kind, l."id" FROM "credit_ledger" l
          LEFT JOIN "wallets" w ON w."id" = l."walletId"
         WHERE w."id" IS NULL OR w."userId" <> l."userId" OR w."ownerType" <> 'user'
            OR w."subjectType" IS NOT NULL OR w."parentWalletId" IS NOT NULL
        UNION ALL
        SELECT 'hold', h."id" FROM "credit_holds" h
          LEFT JOIN "wallets" w ON w."id" = h."walletId"
         WHERE w."id" IS NULL OR w."userId" <> h."userId" OR w."ownerType" <> 'user'
            OR w."subjectType" IS NOT NULL OR w."parentWalletId" IS NOT NULL`);
      expect(mismatched).toEqual([]);
      const counts = await s.query<{ ledger: number; holds: number }>(
        `SELECT (SELECT count(*)::int FROM "credit_ledger") AS ledger, (SELECT count(*)::int FROM "credit_holds") AS holds`,
      );
      expect(counts[0]).toEqual({ ledger: 9, holds: 4 });

      // New rows too: the column is NOT NULL, so a write without a wallet is refused.
      const refused = await s.pool
        .query(`INSERT INTO "credit_holds" ("id", "userId", "estCents", "expiresAt") VALUES ('h_new', 'u_paid', 1, now())`)
        .then(() => null, (err: Error) => err.message);
      expect(refused).toMatch(/null value in column "walletId"/);
      expect(s.notices.join('\n')).toContain('wallets backfill complete');
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('X-5 (partial): running the backfill again changes nothing (idempotent)', async () => {
    const s = await openScenario('idempotent');
    try {
      await seedCorpus(s);
      await s.migrate(throughThisChange);
      const once = await fullSnapshot(s);

      // (e) the exact 0301 statements, committed, a second time.
      const report = await withClient(s.pool, (c) => runWalletBackfill(c, { dryRun: false, statements: walletBackfillStatements(MIGRATIONS_DIR) }));
      expect(report.committed).toBe(true);
      expect(report.walletsCreated).toBe(0);
      expect(report.ledgerRowsAssigned).toBe(0);
      expect(report.holdRowsAssigned).toBe(0);
      expect(report.after).toEqual(report.before);
      expect(await fullSnapshot(s)).toBe(once);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('X-5 (partial): --dry-run reports the backfill and writes nothing; the real run then does exactly that', async () => {
    const s = await openScenario('dryrun');
    try {
      await seedCorpus(s);
      await s.migrate(throughExpand); // columns exist, backfill not yet run
      const untouched = await fullSnapshot(s);

      // (f) dry-run: the report names the work, and the database is byte-for-byte unchanged.
      const dry = await withClient(s.pool, (c) => runWalletBackfill(c, { dryRun: true, statements: walletBackfillStatements(MIGRATIONS_DIR) }));
      expect(dry.committed).toBe(false);
      expect(dry.before.ledgerMissingWallet).toBe(9);
      expect(dry.before.holdsMissingWallet).toBe(4);
      expect(dry).toMatchObject({ walletsCreated: 1, ledgerRowsAssigned: 9, holdRowsAssigned: 4 });
      expect(await fullSnapshot(s)).toBe(untouched);
      const stillNull = await s.query<{ n: number }>(
        `SELECT ((SELECT count(*) FROM "credit_ledger" WHERE "walletId" IS NULL) + (SELECT count(*) FROM "credit_holds" WHERE "walletId" IS NULL))::int AS n`,
      );
      expect(stillNull[0].n).toBe(13);

      // The real run does what the dry run said, and moves no money.
      const real = await withClient(s.pool, (c) => runWalletBackfill(c, { dryRun: false, statements: walletBackfillStatements(MIGRATIONS_DIR) }));
      expect(real).toMatchObject({ committed: true, walletsCreated: 1, ledgerRowsAssigned: 9, holdRowsAssigned: 4 });
      expect(moneyDrift(real.before, real.after)).toEqual([]);

      // And the rest of the chain applies on top of the repaired database.
      await s.migrate(throughThisChange);
      const nulls = await s.query<{ n: number }>(`SELECT count(*)::int AS n FROM "credit_ledger" WHERE "walletId" IS NULL`);
      expect(nulls[0].n).toBe(0);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('WAL-1 (partial) WAL-2 (partial): the wallets table refuses shapes and values that are not money', async () => {
    const s = await openScenario('constraints');
    try {
      await seedCorpus(s);
      await s.migrate(throughThisChange);
      await s.query(
        `INSERT INTO "organizations" ("id", "name", "slug", "ownerId") VALUES ('o_1', 'Northwind', 'northwind', 'u_paid')`,
      );
      const attempt = (sql: string) => s.pool.query(sql).then(() => 'ok', (err: Error) => err.message);

      // Non-negativity, carried over from credit_balances, on every money column.
      for (const column of ['monthlyRemainingCents', 'monthlyAllowanceCents', 'spentCents', 'topupRemainingCents', 'debtCents']) {
        expect(await attempt(`UPDATE "wallets" SET "${column}" = -1 WHERE "userId" = 'u_paid'`), column).toMatch(/violates check constraint/);
      }
      expect(await attempt(`UPDATE "wallets" SET "pendingMillicents" = 1000 WHERE "userId" = 'u_paid'`)).toMatch(/wallets_pending_millicents_range/);
      expect(await attempt(`UPDATE "wallets" SET "monthlyPeriodEnd" = '2020-01-01' WHERE "userId" = 'u_paid'`)).toMatch(/wallets_period_order/);

      // One personal root wallet per user.
      expect(await attempt(`INSERT INTO "wallets" ("ownerType", "userId") VALUES ('user', 'u_paid')`)).toMatch(/wallets_personal_root_unique/);
      // Owner type must name the owner that is set, and only that one.
      expect(await attempt(`INSERT INTO "wallets" ("ownerType", "userId") VALUES ('org', 'u_bystander')`)).toMatch(/wallets_owner_matches_type/);
      expect(await attempt(`INSERT INTO "wallets" ("ownerType", "userId", "orgId") VALUES ('user', 'u_bystander', 'o_1')`)).toMatch(/wallets_owner_matches_type/);
      expect(await attempt(`INSERT INTO "wallets" ("ownerType", "userId", "status") VALUES ('user', 'u_bystander', 'frozen')`)).toMatch(/wallets_status_valid/);
      expect(await attempt(`INSERT INTO "wallets" ("ownerType", "userId", "subjectType") VALUES ('user', 'u_bystander', 'drive')`)).toMatch(/wallets_subject_complete/);

      // WAL-2: an org pool (org, no subject, no parent), one per org; a drive wallet under it.
      expect(await attempt(`INSERT INTO "wallets" ("id", "ownerType", "orgId") VALUES ('w_pool', 'org', 'o_1')`)).toBe('ok');
      expect(await attempt(`INSERT INTO "wallets" ("ownerType", "orgId") VALUES ('org', 'o_1')`)).toMatch(/wallets_org_pool_unique/);
      expect(await attempt(
        `INSERT INTO "wallets" ("id", "ownerType", "orgId", "subjectType", "subjectId", "parentWalletId") VALUES ('w_drive', 'org', 'o_1', 'drive', 'd_1', 'w_pool')`,
      )).toBe('ok');
      expect(await attempt(
        `INSERT INTO "wallets" ("ownerType", "orgId", "subjectType", "subjectId", "parentWalletId") VALUES ('org', 'o_1', 'drive', 'd_1', 'w_pool')`,
      )).toMatch(/wallets_subject_unique/);
      // A personal drive wallet owned by a user who already has a root: not a second root.
      expect(await attempt(
        `INSERT INTO "wallets" ("ownerType", "userId", "subjectType", "subjectId", "parentWalletId") SELECT 'user', 'u_paid', 'drive', 'd_2', "id" FROM "wallets" WHERE "userId" = 'u_paid' AND "subjectType" IS NULL`,
      )).toBe('ok');

      // WAL-7 caps: keyed (walletId, consumerKey), non-negative, null = unlimited.
      expect(await attempt(`INSERT INTO "wallet_consumer_caps" ("walletId", "consumerKey", "dailyCapCents") VALUES ('w_drive', 'user:u_free', 1000)`)).toBe('ok');
      expect(await attempt(`INSERT INTO "wallet_consumer_caps" ("walletId", "consumerKey") VALUES ('w_drive', 'user:u_free')`)).toMatch(/wallet_consumer_caps_pkey/);
      expect(await attempt(`INSERT INTO "wallet_consumer_caps" ("walletId", "consumerKey", "monthlyCapCents") VALUES ('w_drive', 'user:u_debt', -1)`)).toMatch(/wallet_consumer_caps_monthly_nonneg/);
      expect(await attempt(`INSERT INTO "wallet_consumer_caps" ("walletId", "consumerKey") VALUES ('w_drive', '')`)).toMatch(/wallet_consumer_caps_consumer_key_nonempty/);
    } finally {
      await s.pool.end();
    }
  }, 180_000);

  it('X-5 (partial): deleting a user still cascades their wallet, ledger and holds, as credit_balances did', async () => {
    const s = await openScenario('cascade');
    try {
      await seedCorpus(s);
      await s.migrate(throughThisChange);
      await s.query(`DELETE FROM "users" WHERE "id" = 'u_paid'`);
      const left = await s.query<{ n: number }>(`
        SELECT ((SELECT count(*) FROM "wallets" WHERE "userId" = 'u_paid')
              + (SELECT count(*) FROM "credit_ledger" WHERE "userId" = 'u_paid')
              + (SELECT count(*) FROM "credit_holds" WHERE "userId" = 'u_paid'))::int AS n`);
      expect(left[0].n).toBe(0);
    } finally {
      await s.pool.end();
    }
  }, 180_000);
});

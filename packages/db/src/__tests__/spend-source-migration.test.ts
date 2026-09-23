/**
 * Migration 0308 — where the spend source is stored (Spec SPEND-3).
 *
 *   conversations.chosenWalletId  the wallet chosen for a conversation; NULL = nothing chosen.
 *                                 No foreign key: a deleted wallet leaves the id behind so the
 *                                 gate refuses it (SET NULL would silently re-source the chat).
 *   wallets.defaultSpendSource    the drive's default (drive wallet) or the person's default
 *                                 (personal root); NULL = no default; never on an org pool.
 *
 * Two layers: the SQL itself (no database), and the CHECK against a real Postgres whenever
 * DATABASE_URL is set. The live layer runs inside ONE transaction that is rolled back, so it
 * leaves no row behind in the shared database, and it ends its pool in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { Pool, type PoolClient } from 'pg';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../drizzle');
const file = readdirSync(MIGRATIONS_DIR).find((f) => /^0308_.*\.sql$/.test(f));
const sql = file ? readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') : '';
const statements = sql.split('--> statement-breakpoint').map((s) => s.trim()).filter(Boolean);

describe('drizzle/0308 — the stored spend source (static)', () => {
  it('SPEND-3 (partial): adds the two nullable columns and the CHECK, and nothing else', () => {
    expect(file).toBeDefined();
    expect(statements).toEqual([
      'ALTER TABLE "conversations" ADD COLUMN "chosenWalletId" text;',
      'ALTER TABLE "wallets" ADD COLUMN "defaultSpendSource" text;',
      `ALTER TABLE "wallets" ADD CONSTRAINT "wallets_default_spend_source_valid" CHECK ("wallets"."defaultSpendSource" IS NULL OR ("wallets"."defaultSpendSource" IN ('drive_wallet', 'seat_allowance', 'own_credits') AND NOT ("wallets"."ownerType" = 'org' AND "wallets"."subjectType" IS NULL)));`,
    ]);
    // Nullable, no default: an existing conversation or wallet gains "nothing chosen", never a wallet.
    expect(sql).not.toMatch(/NOT NULL|DEFAULT|REFERENCES/);
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
const describeLive = DATABASE_URL ? describe : describe.skip;

describeLive('drizzle/0308 against a real Postgres', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    pool.on('error', () => {});
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO "users" ("id", "name", "email", "createdAt", "updatedAt") VALUES
         ('c6_u_marcus', 'c6_u_marcus', 'c6_u_marcus@example.test', now(), now()),
         ('c6_u_jono', 'c6_u_jono', 'c6_u_jono@example.test', now(), now())`,
    );
    await client.query(`INSERT INTO "organizations" ("id", "name", "slug", "ownerId") VALUES ('c6_o_northwind', 'Northwind Labs', 'c6-northwind', 'c6_u_jono')`);
    await client.query(`INSERT INTO "wallets" ("id", "ownerType", "userId") VALUES ('c6_w_marcus', 'user', 'c6_u_marcus')`);
    await client.query(`INSERT INTO "wallets" ("id", "ownerType", "orgId") VALUES ('c6_w_pool', 'org', 'c6_o_northwind')`);
    await client.query(
      `INSERT INTO "wallets" ("id", "ownerType", "orgId", "subjectType", "subjectId", "parentWalletId")
       VALUES ('c6_w_product', 'org', 'c6_o_northwind', 'drive', 'c6_d_product', 'c6_w_pool')`,
    );
  });

  afterAll(async () => {
    // Everything this suite wrote was inside the transaction: nothing is left behind.
    await client?.query('ROLLBACK').catch(() => {});
    client?.release();
    await pool?.end();
  });

  async function attempt(statement: string): Promise<string> {
    await client.query('SAVEPOINT attempt');
    try {
      await client.query(statement);
      await client.query('RELEASE SAVEPOINT attempt');
      return 'ok';
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT attempt');
      return err instanceof Error ? err.message : String(err);
    }
  }

  const setDefault = (walletId: string, value: string) =>
    attempt(`UPDATE "wallets" SET "defaultSpendSource" = '${value}' WHERE "id" = '${walletId}'`);

  it('SPEND-3 (partial): a drive wallet and a personal root accept each of the three kinds', async () => {
    for (const kind of ['drive_wallet', 'seat_allowance', 'own_credits']) {
      expect(await setDefault('c6_w_product', kind), kind).toBe('ok');
      expect(await setDefault('c6_w_marcus', kind), kind).toBe('ok');
    }
  });

  it('SPEND-3 (partial): an unknown kind is refused on every wallet', async () => {
    for (const walletId of ['c6_w_product', 'c6_w_marcus']) {
      expect(await setDefault(walletId, 'org_pool')).toMatch(/wallets_default_spend_source_valid/);
      expect(await setDefault(walletId, '')).toMatch(/wallets_default_spend_source_valid/);
    }
  });

  it('SPEND-3 (partial): the org pool refuses any default, even a known kind', async () => {
    for (const kind of ['drive_wallet', 'seat_allowance', 'own_credits']) {
      expect(await setDefault('c6_w_pool', kind), kind).toMatch(/wallets_default_spend_source_valid/);
    }
    expect(await attempt(`INSERT INTO "wallets" ("ownerType", "orgId", "defaultSpendSource") VALUES ('org', 'c6_o_northwind', 'seat_allowance')`))
      .toMatch(/wallets_default_spend_source_valid/);
  });

  it('SPEND-3 (partial): a conversation may name a wallet id that no longer exists (no FK), so the gate, not the database, refuses it', async () => {
    await client.query(`INSERT INTO "conversations" ("id", "userId", "type", "updatedAt") VALUES ('c6_c_1', 'c6_u_marcus', 'global', now())`);
    expect(await attempt(`UPDATE "conversations" SET "chosenWalletId" = 'c6_w_product' WHERE "id" = 'c6_c_1'`)).toBe('ok');
    expect(await attempt(`DELETE FROM "wallets" WHERE "id" = 'c6_w_product'`)).toBe('ok');
    const { rows } = await client.query<{ chosenWalletId: string | null }>(`SELECT "chosenWalletId" FROM "conversations" WHERE "id" = 'c6_c_1'`);
    // The stale id is still there: nothing re-sourced the conversation.
    expect(rows[0]?.chosenWalletId).toBe('c6_w_product');
  });
});

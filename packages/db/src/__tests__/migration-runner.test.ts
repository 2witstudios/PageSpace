/**
 * Migration-runner core tests (#890 Phase 1, leaf 3).
 *
 * The per-migration-transaction runner (extracted from migrate.ts) is
 * parameterized over the journal location so the main DB ('drizzle' schema)
 * and the Admin PG ('drizzle_admin' schema) never collide. Tests inject a
 * fake executor — no test opens a connection.
 */
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  runMigrations,
  type MigrationExecutor,
  type RunnableMigration,
} from '../migration-runner';

const dialect = new PgDialect();

interface FakeDb {
  executor: MigrationExecutor;
  executed: string[];
  transactionCount: () => number;
}

const makeFakeDb = (appliedHashes: string[] = []): FakeDb => {
  const executed: string[] = [];
  let transactions = 0;
  const executor: MigrationExecutor = {
    async execute(query: SQL) {
      const text = dialect.sqlToQuery(query).sql;
      executed.push(text);
      if (/select/i.test(text) && text.includes('hash')) {
        return { rows: appliedHashes.map((hash) => ({ hash })) };
      }
      return { rows: [] };
    },
    async transaction<T>(cb: (tx: MigrationExecutor) => Promise<T>): Promise<T> {
      transactions += 1;
      return cb(executor);
    },
  };
  return { executor, executed, transactionCount: () => transactions };
};

const migration = (hash: string, statements: string[]): RunnableMigration => ({
  hash,
  folderMillis: 1720000000000,
  sql: statements,
});

const ADMIN_JOURNAL = {
  migrationsSchema: 'drizzle_admin',
  migrationsTable: '__drizzle_migrations',
};

describe('runMigrations', () => {
  it('should create the journal schema and table under the given identifiers', async () => {
    const { executor, executed } = makeFakeDb();
    await runMigrations(executor, [], ADMIN_JOURNAL);

    expect(executed.some((s) => /CREATE SCHEMA IF NOT EXISTS "drizzle_admin"/.test(s))).toBe(true);
    expect(
      executed.some((s) =>
        /CREATE TABLE IF NOT EXISTS "drizzle_admin"\."__drizzle_migrations"/.test(s),
      ),
    ).toBe(true);
  });

  it('should never touch the main journal schema when given the admin journal', async () => {
    const { executor, executed } = makeFakeDb();
    await runMigrations(executor, [migration('abc', ['SELECT 1'])], ADMIN_JOURNAL);

    expect(executed.some((s) => s.includes('"drizzle".'))).toBe(false);
  });

  it('should apply a pending migration and record its hash in the journal', async () => {
    const { executor, executed } = makeFakeDb();
    await runMigrations(
      executor,
      [migration('abc', ['CREATE TABLE "t" ("id" text)'])],
      ADMIN_JOURNAL,
    );

    expect(executed).toContain('CREATE TABLE "t" ("id" text)');
    expect(
      executed.some((s) =>
        /INSERT INTO "drizzle_admin"\."__drizzle_migrations"/.test(s),
      ),
    ).toBe(true);
  });

  it('should skip migrations whose hash is already applied', async () => {
    const { executor, executed, transactionCount } = makeFakeDb(['abc']);
    await runMigrations(
      executor,
      [migration('abc', ['CREATE TABLE "t" ("id" text)'])],
      ADMIN_JOURNAL,
    );

    expect(executed).not.toContain('CREATE TABLE "t" ("id" text)');
    expect(transactionCount()).toBe(0);
  });

  it('should run each pending migration in its own transaction', async () => {
    const { executor, transactionCount } = makeFakeDb(['already-applied']);
    await runMigrations(
      executor,
      [
        migration('already-applied', ['SELECT 0']),
        migration('one', ['SELECT 1']),
        migration('two', ['SELECT 2', 'SELECT 3']),
      ],
      ADMIN_JOURNAL,
    );

    expect(transactionCount()).toBe(2);
  });

  it('should support the main journal identifiers unchanged (drizzle schema)', async () => {
    const { executor, executed } = makeFakeDb();
    await runMigrations(executor, [], {
      migrationsSchema: 'drizzle',
      migrationsTable: '__drizzle_migrations',
    });

    expect(
      executed.some((s) =>
        /CREATE TABLE IF NOT EXISTS "drizzle"\."__drizzle_migrations"/.test(s),
      ),
    ).toBe(true);
  });
});

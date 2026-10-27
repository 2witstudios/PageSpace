import { sql, type SQL } from 'drizzle-orm';

/**
 * Per-migration-transaction runner core (extracted from migrate.ts, #890
 * Phase 1) — parameterized over the journal location so the main DB
 * ('drizzle' schema) and the Admin PG ('drizzle_admin' schema) keep fully
 * independent journals.
 *
 * Drizzle's built-in migrate() runs ALL pending migrations in a single
 * transaction, which breaks when a migration adds an enum value (ALTER TYPE
 * ADD VALUE) and a later migration uses that value — PostgreSQL error 55P04:
 * "New enum values must be committed before they can be used."
 * This runner commits each migration individually, fixing the enum issue.
 */

/** Structural subset of drizzle's MigrationMeta (readMigrationFiles output). */
export interface RunnableMigration {
  hash: string;
  folderMillis: number;
  sql: string[];
}

export interface MigrationJournal {
  migrationsSchema: string;
  migrationsTable: string;
}

/** Minimal executor surface — satisfied by NodePgDatabase and PgTransaction. */
export interface MigrationExecutor {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
  transaction<T>(cb: (tx: MigrationExecutor) => Promise<T>): Promise<T>;
}

export async function runMigrations(
  db: MigrationExecutor,
  migrations: readonly RunnableMigration[],
  journal: MigrationJournal,
  log: (message: string) => void = () => {},
): Promise<void> {
  const { migrationsSchema, migrationsTable } = journal;

  // Ensure schema and table exist
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(migrationsSchema)}`);
  await db.execute(
    sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)} (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )`
  );

  // Load all applied migration hashes — checking by hash (not by max timestamp) is
  // required because migrations regenerated after a collision can receive timestamps
  // older than already-applied migrations, causing the simpler "last timestamp" check
  // to silently skip them.
  const dbMigrations = await db.execute(
    sql`SELECT hash FROM ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)}`
  );
  const appliedHashes = new Set((dbMigrations.rows as { hash: string }[]).map((r) => r.hash));

  for (const migration of migrations) {
    if (!appliedHashes.has(migration.hash)) {
      log(`  Applying: ${migration.hash.substring(0, 8)}... (${migration.folderMillis})`);

      await db.transaction(async (tx) => {
        for (const stmt of migration.sql) {
          await tx.execute(sql.raw(stmt));
        }
        await tx.execute(
          sql`INSERT INTO ${sql.identifier(migrationsSchema)}.${sql.identifier(migrationsTable)} ("hash", "created_at") VALUES (${migration.hash}, ${migration.folderMillis})`
        );
      });
    }
  }
}

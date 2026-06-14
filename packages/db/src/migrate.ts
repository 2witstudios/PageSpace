
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import { db } from "./db";

/**
 * Custom migration runner that executes each migration in its own transaction.
 *
 * Drizzle's built-in migrate() runs ALL pending migrations in a single transaction,
 * which breaks when a migration adds an enum value (ALTER TYPE ADD VALUE) and a
 * later migration uses that value — PostgreSQL error 55P04:
 * "New enum values must be committed before they can be used."
 *
 * This runner commits each migration individually, fixing the enum issue.
 */
async function main() {
  console.log("Running migrations...");
  console.log("DATABASE_URL:", process.env.DATABASE_URL ? "Set" : "Not set");

  const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });

  const migrationsSchema = "drizzle";
  const migrationsTable = "__drizzle_migrations";

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
      console.log(`  Applying: ${migration.hash.substring(0, 8)}... (${migration.folderMillis})`);

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

  console.log("Migrations finished.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


import { drizzle } from "drizzle-orm/node-postgres";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getMigrationPool } from "./db";
import { runMigrations } from "./migration-runner";

/**
 * Main-DB migration entrypoint. The per-migration-transaction logic lives in
 * migration-runner.ts (shared with the Admin PG runner, migrate-admin.ts);
 * this shell only binds the main journal: ./drizzle + the 'drizzle' schema.
 *
 * Runs on getMigrationPool(), NOT the app-throttled `db` — migrations run
 * DDL that can legitimately exceed the app pool's statement_timeout/
 * lock_timeout (see getMigrationPool()'s doc comment in db.ts).
 */
async function main() {
  console.log("Running migrations...");
  console.log("DATABASE_URL:", process.env.DATABASE_URL ? "Set" : "Not set");

  const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
  const migrationPool = getMigrationPool();

  await runMigrations(
    drizzle(migrationPool),
    migrations,
    { migrationsSchema: "drizzle", migrationsTable: "__drizzle_migrations" },
    console.log,
  );

  await migrationPool.end();
  console.log("Migrations finished.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

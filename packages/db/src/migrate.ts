
import { readMigrationFiles } from "drizzle-orm/migrator";
import { db } from "./db";
import { runMigrations } from "./migration-runner";

/**
 * Main-DB migration entrypoint. The per-migration-transaction logic lives in
 * migration-runner.ts (shared with the Admin PG runner, migrate-admin.ts);
 * this shell only binds the main journal: ./drizzle + the 'drizzle' schema.
 */
async function main() {
  console.log("Running migrations...");
  console.log("DATABASE_URL:", process.env.DATABASE_URL ? "Set" : "Not set");

  const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });

  await runMigrations(
    db,
    migrations,
    { migrationsSchema: "drizzle", migrationsTable: "__drizzle_migrations" },
    console.log,
  );

  console.log("Migrations finished.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

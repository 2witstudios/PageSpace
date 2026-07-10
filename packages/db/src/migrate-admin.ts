import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { runMigrations } from './migration-runner';
import { resolveAdminMigrateDecision, type AdminMigrateEnv } from './admin-db-mode';

/**
 * Admin PG (trust plane) migration entrypoint — db:migrate:admin (#890
 * Phase 1). Separate journal end to end: ./drizzle-admin on disk, the
 * 'drizzle_admin' schema in the database — the main pipeline (migrate.ts →
 * ./drizzle → 'drizzle') is never touched.
 *
 * Migrations run ONLY against a dedicated Admin PG: break-glass is a runtime
 * degradation for audit writes, and honoring it here would plant the admin
 * journal (and future admin DDL) in the main application database.
 */

export const ADMIN_MIGRATIONS_FOLDER = 'drizzle-admin';
export const ADMIN_MIGRATIONS_SCHEMA = 'drizzle_admin';
export const ADMIN_MIGRATIONS_TABLE = '__drizzle_migrations';

export async function migrateAdminDb(
  env: AdminMigrateEnv,
  log: (message: string) => void = () => {},
): Promise<void> {
  const decision = resolveAdminMigrateDecision(env);
  if (!decision.ok) {
    throw new Error(`db:migrate:admin refused: ${decision.reason}`);
  }

  const migrations = readMigrationFiles({ migrationsFolder: ADMIN_MIGRATIONS_FOLDER });

  const pool = new Pool(decision.poolConfig);
  try {
    await runMigrations(
      drizzle(pool),
      migrations,
      { migrationsSchema: ADMIN_MIGRATIONS_SCHEMA, migrationsTable: ADMIN_MIGRATIONS_TABLE },
      log,
    );
  } finally {
    await pool.end();
  }
}

async function main() {
  console.log('Running admin (trust plane) migrations...');
  console.log('ADMIN_DATABASE_URL:', process.env.ADMIN_DATABASE_URL ? 'Set' : 'Not set');
  console.log(
    'ADMIN_DATABASE_URL_MIGRATE:',
    process.env.ADMIN_DATABASE_URL_MIGRATE ? 'Set (preferred for migrations)' : 'Not set',
  );

  await migrateAdminDb(
    {
      ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL,
      ADMIN_DATABASE_URL_MIGRATE: process.env.ADMIN_DATABASE_URL_MIGRATE,
      ADMIN_DATABASE_SSL: process.env.ADMIN_DATABASE_SSL,
      ADMIN_DB_POOL_MAX: process.env.ADMIN_DB_POOL_MAX,
      ADMIN_DB_BREAK_GLASS: process.env.ADMIN_DB_BREAK_GLASS,
    },
    console.log,
  );

  console.log('Admin migrations finished.');
  process.exit(0);
}

// Run only as a script (tsx src/migrate-admin.ts) — importing this module
// (e.g. from the integration smoke test) must not trigger a migration.
if (process.argv[1]?.includes('migrate-admin')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

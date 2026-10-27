import 'dotenv/config';
import { Pool } from 'pg';
import {
  resolveAdminMigrateDecision,
  type AdminMigrateEnv,
} from './admin-db-mode';
import {
  planAdminLoginUsers,
  buildLoginUserStatements,
  type AdminLoginUserEnv,
} from './admin-login-users';

/**
 * Per-service Admin PG LOGIN user provisioning — db:provision:admin-users
 * (#890 Phase 2, leaf 0). Thin shell over the pure planner/builder in
 * admin-login-users.ts: connects with the OWNER credentials (same decision
 * gate as db:migrate:admin — dedicated Admin PG only, never break-glass),
 * creates/updates the login users whose passwords are present in env, and
 * grants their NOLOGIN template roles. Idempotent; re-running rotates
 * passwords. Runs from the migrate one-shot right after db:migrate:admin.
 */

export type ProvisionEnv = AdminMigrateEnv & AdminLoginUserEnv;

export async function provisionAdminLoginUsers(
  env: ProvisionEnv,
  log: (message: string) => void = () => {},
): Promise<{ provisioned: string[]; skipped: string[] }> {
  const plan = planAdminLoginUsers(env);
  if (!plan.ok) {
    throw new Error(`db:provision:admin-users refused: ${plan.reason}`);
  }

  if (plan.skipped.length > 0) {
    log(`Skipping (no password in env): ${plan.skipped.join(', ')}`);
  }
  if (plan.provision.length === 0) {
    log('No admin login users to provision.');
    return { provisioned: [], skipped: plan.skipped };
  }

  const decision = resolveAdminMigrateDecision(env);
  if (!decision.ok) {
    throw new Error(`db:provision:admin-users refused: ${decision.reason}`);
  }

  const pool = new Pool(decision.poolConfig);
  try {
    for (const entry of plan.provision) {
      for (const statement of buildLoginUserStatements(entry)) {
        await pool.query(statement);
      }
      log(`Provisioned ${entry.user} (granted: ${entry.roles.join(', ')})`);
    }
  } finally {
    await pool.end();
  }

  return { provisioned: plan.provision.map((p) => p.user), skipped: plan.skipped };
}

async function main() {
  console.log('Provisioning admin (trust plane) login users...');

  await provisionAdminLoginUsers(
    {
      ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL,
      ADMIN_DATABASE_URL_MIGRATE: process.env.ADMIN_DATABASE_URL_MIGRATE,
      ADMIN_DATABASE_SSL: process.env.ADMIN_DATABASE_SSL,
      ADMIN_DB_POOL_MAX: process.env.ADMIN_DB_POOL_MAX,
      ADMIN_DB_BREAK_GLASS: process.env.ADMIN_DB_BREAK_GLASS,
      ADMIN_APP_PASSWORD: process.env.ADMIN_APP_PASSWORD,
      ADMIN_PROCESSOR_PASSWORD: process.env.ADMIN_PROCESSOR_PASSWORD,
      ADMIN_READER_PASSWORD: process.env.ADMIN_READER_PASSWORD,
      ADMIN_ERASER_PASSWORD: process.env.ADMIN_ERASER_PASSWORD,
    },
    console.log,
  );

  console.log('Admin login user provisioning finished.');
  process.exit(0);
}

// Run only as a script (tsx src/provision-admin-users.ts) — importing this
// module (e.g. from the integration test) must not trigger provisioning.
if (process.argv[1]?.includes('provision-admin-users')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

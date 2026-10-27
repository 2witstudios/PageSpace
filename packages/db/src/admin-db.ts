/**
 * adminDb — the Admin PG (trust plane) client (#890 Phase 1).
 *
 * Composition root for the dedicated admin Postgres that will hold the
 * tamper-evident security audit chain and related trust-plane tables. Mode
 * selection is pure (admin-db-mode.ts); this shell only constructs the pool
 * and wires deps. Init is lazy — importing this module opens no connection.
 *
 * Schema binding: the admin schema barrel (admin-schema.ts) — EXACTLY the
 * trust-plane tables; the query API (adminDb.query.*) is typed against it.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { pool as mainPool } from './db';
import * as adminSchema from './admin-schema';
import { registerPool } from './pool-stats';
import {
  resolveAdminDbMode,
  resolveAdminPoolConfig,
  type AdminDbEnv,
  type AdminDbModeDecision,
  type AdminPoolConfig,
} from './admin-db-mode';

export {
  resolveAdminDbMode,
  resolveAdminPoolConfig,
  type AdminDbEnv,
  type AdminDbModeDecision,
  type AdminDbModeName,
  type AdminPoolConfig,
} from './admin-db-mode';

export type AdminDatabase = NodePgDatabase<typeof adminSchema>;

export const ADMIN_POOL_NAME = 'admin';

export interface AdminDbDeps {
  getEnv: () => AdminDbEnv;
  getMainDb: () => AdminDatabase;
  createPool: (config: AdminPoolConfig) => Pool;
  registerPool: (pool: Pool, name: string) => void;
  alert: (message: string) => void;
}

export interface AdminDbRegistry {
  getAdminDb: () => AdminDatabase;
  /**
   * Resolved-mode readback for callers that must BRANCH on the mode without
   * triggering init side effects (#890 Phase 2, leaf 5): the audit bind point
   * routes writes to the ingest path only under 'dedicated' and keeps the
   * legacy main-DB path under 'break-glass'. Pure observation — never
   * constructs a pool, never alerts, never throws; re-reads env each call so
   * late-loaded dotenv wins, same as init.
   */
  getMode: () => AdminDbModeDecision;
}

const breakGlassAlert = (reason: string): string =>
  [
    '████████████████████████████████████████████████████████████████████',
    '██ SECURITY ALERT — ADMIN DB BREAK-GLASS ACTIVE                    ██',
    '████████████████████████████████████████████████████████████████████',
    `Audit/trust-plane writes are going to the MAIN application database: ${reason}.`,
    'This is an emergency rollback state, never a supported steady state.',
    'Provision the Admin PG, set ADMIN_DATABASE_URL, and remove ADMIN_DB_BREAK_GLASS.',
  ].join('\n');

export function createAdminDbRegistry(deps: AdminDbDeps): AdminDbRegistry {
  let instance: AdminDatabase | null = null;

  const init = (): AdminDatabase => {
    const env = deps.getEnv();
    const decision = resolveAdminDbMode(env);

    switch (decision.mode) {
      case 'dedicated': {
        const pool = deps.createPool(resolveAdminPoolConfig(env));
        // Prevent uncaughtException spam when the network drops idle
        // connections — same guard as the main pool in db.ts.
        pool.on('error', () => {});
        deps.registerPool(pool, ADMIN_POOL_NAME);
        return drizzle(pool, { schema: adminSchema });
      }
      case 'break-glass': {
        deps.alert(breakGlassAlert(decision.reason));
        return deps.getMainDb();
      }
      case 'main-db':
        // Unconfigured trust plane: audit writes use the main DB — the
        // pre-trust-plane default. SILENT: no alert, no throw. (The break-glass
        // path is the loud, explicit variant of the same fallback.)
        return deps.getMainDb();
      case 'fail':
        throw new Error(`adminDb init failed: ${decision.reason}`);
    }
  };

  return {
    getAdminDb() {
      if (!instance) instance = init();
      return instance;
    },
    getMode() {
      return resolveAdminDbMode(deps.getEnv());
    },
  };
}

const registry = createAdminDbRegistry({
  // Env is read at init time, not import time, so late-loaded dotenv wins.
  getEnv: () => ({
    ADMIN_DATABASE_URL: process.env.ADMIN_DATABASE_URL,
    ADMIN_DATABASE_SSL: process.env.ADMIN_DATABASE_SSL,
    ADMIN_DB_POOL_MAX: process.env.ADMIN_DB_POOL_MAX,
    ADMIN_DB_BREAK_GLASS: process.env.ADMIN_DB_BREAK_GLASS,
    AUDIT_TRUST_PLANE_REQUIRED: process.env.AUDIT_TRUST_PLANE_REQUIRED,
  }),
  // Break-glass only: an admin-schema-typed client over the MAIN pool — same
  // database and connections as `db`, narrow trust-plane type, no cast.
  getMainDb: () => drizzle(mainPool, { schema: adminSchema }),
  createPool: (config) => new Pool(config),
  registerPool,
  alert: (message) => console.error(message),
});

/**
 * Per-process adminDb accessor. Lazy: connects (or throws, or degrades with a
 * loud alert) on first call, then returns the same instance for the process.
 */
export const getAdminDb = (): AdminDatabase => registry.getAdminDb();

/**
 * Resolved Admin PG mode for the current process env. Side-effect free —
 * see AdminDbRegistry.getMode().
 */
export const getAdminDbMode = (): AdminDbModeDecision => registry.getMode();

/**
 * adminDb — the Admin PG (trust plane) client (#890 Phase 1).
 *
 * Composition root for the dedicated admin Postgres that will hold the
 * tamper-evident security audit chain and related trust-plane tables. Mode
 * selection is pure (admin-db-mode.ts); this shell only constructs the pool
 * and wires deps. Init is lazy — importing this module opens no connection.
 *
 * Schema binding: leaf 3 builds the admin schema barrel; until then the
 * client is drizzle-bound without a schema.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { db } from './db';
import { registerPool } from './pool-stats';
import {
  resolveAdminDbMode,
  resolveAdminPoolConfig,
  type AdminDbEnv,
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

export type AdminDatabase = NodePgDatabase<Record<string, never>>;

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
        return drizzle(pool);
      }
      case 'break-glass': {
        deps.alert(breakGlassAlert(decision.reason));
        return deps.getMainDb();
      }
      case 'fail':
        throw new Error(`adminDb init failed: ${decision.reason}`);
    }
  };

  return {
    getAdminDb() {
      if (!instance) instance = init();
      return instance;
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
  }),
  // Break-glass only. Cast is transitional: leaf 3 binds the admin schema
  // barrel and narrows AdminDatabase to it.
  getMainDb: () => db as unknown as AdminDatabase,
  createPool: (config) => new Pool(config),
  registerPool,
  alert: (message) => console.error(message),
});

/**
 * Per-process adminDb accessor. Lazy: connects (or throws, or degrades with a
 * loud alert) on first call, then returns the same instance for the process.
 */
export const getAdminDb = (): AdminDatabase => registry.getAdminDb();

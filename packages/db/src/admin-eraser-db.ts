/**
 * GDPR eraser connection to the Admin PG (#890 Phase 2, leaf 6).
 *
 * The Art 17 pseudonymization path must UPDATE the 6 PII columns on the
 * trust-plane security_audit_log — a write the runtime web identity
 * (admin_app, INSERT-only) rightly cannot perform. It runs as its own LOGIN
 * user, admin_gdpr_eraser_user (template role admin_gdpr_eraser: SELECT +
 * column-scoped UPDATE on exactly user_id, session_id, ip_address, ip_bidx,
 * user_agent, geo_location — provisioned by db:provision:admin-users), over
 * a small dedicated pool from ADMIN_ERASER_DATABASE_URL.
 *
 * Deliberately NOT part of the AdminDb registry: the eraser has no
 * break-glass and no fallback. When the URL is missing the accessor THROWS
 * with an actionable reason — erasure against the wrong store or via the
 * wrong identity must never happen silently. (Under break-glass the whole
 * audit surface lives in the main DB and the erasure path never asks for
 * this client — see packages/lib pseudonymize-targets.)
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as adminSchema from './admin-schema';
import type { AdminDatabase } from './admin-db';
import { registerPool } from './pool-stats';
import { resolveAdminPoolConfig, type AdminPoolConfig } from './admin-db-mode';

export interface AdminEraserDbEnv {
  ADMIN_ERASER_DATABASE_URL?: string | undefined;
  ADMIN_DATABASE_SSL?: string | undefined;
}

export type AdminEraserDbModeDecision =
  | { mode: 'available'; reason: string }
  | { mode: 'unavailable'; reason: string };

const isPostgresUrl = (url: string): boolean =>
  url.startsWith('postgresql://') || url.startsWith('postgres://');

export const resolveAdminEraserDbMode = (env: AdminEraserDbEnv): AdminEraserDbModeDecision => {
  const url = env.ADMIN_ERASER_DATABASE_URL;

  // Empty string is treated as unset, matching the ADMIN_DATABASE_URL contract.
  if (url !== undefined && url !== '') {
    if (!isPostgresUrl(url)) {
      return {
        mode: 'unavailable',
        reason:
          'ADMIN_ERASER_DATABASE_URL is set but is not a postgres:// or postgresql:// connection string. ' +
          'Fix the URL — an invalid eraser target is never used as-is.',
      };
    }
    return { mode: 'available', reason: 'ADMIN_ERASER_DATABASE_URL is set' };
  }

  return {
    mode: 'unavailable',
    reason:
      'ADMIN_ERASER_DATABASE_URL is not set. GDPR audit pseudonymization on the Admin PG requires the ' +
      'admin_gdpr_eraser_user LOGIN (provisioned by db:provision:admin-users from ADMIN_ERASER_PASSWORD). ' +
      'Set ADMIN_ERASER_DATABASE_URL to the Admin PG with those credentials.',
  };
};

/** Erasure is a rare, admin-triggered operation — two connections is plenty. */
export const ADMIN_ERASER_POOL_MAX = 2;

export const ADMIN_ERASER_POOL_NAME = 'admin-eraser';

export interface AdminEraserDbDeps {
  getEnv: () => AdminEraserDbEnv;
  createPool: (config: AdminPoolConfig) => Pool;
  registerPool: (pool: Pool, name: string) => void;
}

export interface AdminEraserDbRegistry {
  /** Lazy per-process eraser client. Throws when unavailable — never falls back. */
  getAdminEraserDb: () => AdminDatabase;
  /** Side-effect-free mode readback (no pool, no throw) for callers that plan/branch. */
  getMode: () => AdminEraserDbModeDecision;
}

export function createAdminEraserDbRegistry(deps: AdminEraserDbDeps): AdminEraserDbRegistry {
  let instance: AdminDatabase | null = null;

  return {
    getAdminEraserDb() {
      if (instance) return instance;

      const env = deps.getEnv();
      const decision = resolveAdminEraserDbMode(env);
      if (decision.mode === 'unavailable') {
        throw new Error(`adminEraserDb init failed: ${decision.reason}`);
      }

      // Reuse the shared pool settings (ssl semantics, keepAlive, timeouts)
      // with the eraser URL and its own small max.
      const pool = deps.createPool({
        ...resolveAdminPoolConfig({
          ADMIN_DATABASE_URL: env.ADMIN_ERASER_DATABASE_URL,
          ADMIN_DATABASE_SSL: env.ADMIN_DATABASE_SSL,
        }),
        max: ADMIN_ERASER_POOL_MAX,
      });
      // Same idle-disconnect guard as the main/admin pools.
      pool.on('error', () => {});
      deps.registerPool(pool, ADMIN_ERASER_POOL_NAME);
      instance = drizzle(pool, { schema: adminSchema });
      return instance;
    },
    getMode() {
      return resolveAdminEraserDbMode(deps.getEnv());
    },
  };
}

const registry = createAdminEraserDbRegistry({
  // Env is read at init time, not import time, so late-loaded dotenv wins.
  getEnv: () => ({
    ADMIN_ERASER_DATABASE_URL: process.env.ADMIN_ERASER_DATABASE_URL,
    ADMIN_DATABASE_SSL: process.env.ADMIN_DATABASE_SSL,
  }),
  createPool: (config) => new Pool(config),
  registerPool,
});

/** Per-process eraser client accessor. Lazy; throws with the reason when unconfigured. */
export const getAdminEraserDb = (): AdminDatabase => registry.getAdminEraserDb();

/** Resolved eraser availability for the current process env. Side-effect free. */
export const getAdminEraserDbMode = (): AdminEraserDbModeDecision =>
  registry.getMode();

export interface AdminAuditDbClient {
  db: AdminDatabase;
  end: () => Promise<void>;
}

/**
 * Direct admin-schema-typed client over arbitrary credentials — for
 * integration tests and one-shot scripts that connect AS a specific LOGIN
 * user (owner, eraser, reader) without going through any registry.
 */
export const createAdminAuditDbClient = (config: {
  connectionString: string;
  ssl?: boolean;
  max?: number;
}): AdminAuditDbClient => {
  const pool = new Pool({
    connectionString: config.connectionString,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    max: config.max ?? 2,
  });
  pool.on('error', () => {});
  return { db: drizzle(pool, { schema: adminSchema }), end: () => pool.end() };
};

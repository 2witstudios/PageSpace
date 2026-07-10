/**
 * Pure decision logic for the Admin PG (trust plane) connection registry
 * (#890 Phase 1). No I/O, no process.env reads — callers pass env values in.
 *
 * Three-state contract:
 *   ADMIN_DATABASE_URL set (valid postgres URL)      → 'dedicated'
 *   URL unset + ADMIN_DB_BREAK_GLASS exactly 'true'  → 'break-glass'
 *   URL unset + flag not armed                       → 'fail'
 *
 * A set-but-invalid URL is 'fail' even when break-glass is armed: a
 * misconfigured deploy must stop, never silently degrade to the main DB.
 */

export interface AdminDbEnv {
  ADMIN_DATABASE_URL?: string | undefined;
  ADMIN_DATABASE_SSL?: string | undefined;
  ADMIN_DB_POOL_MAX?: string | undefined;
  ADMIN_DB_BREAK_GLASS?: string | undefined;
}

export type AdminDbModeName = 'dedicated' | 'break-glass' | 'fail';

export interface AdminDbModeDecision {
  mode: AdminDbModeName;
  reason: string;
}

const isPostgresUrl = (url: string): boolean =>
  url.startsWith('postgresql://') || url.startsWith('postgres://');

// Fail-closed: only the exact string 'true' arms the fallback. 'TRUE', '1',
// ' true ', '' etc. do not — mirrors the serverEnvSchema contract from leaf 1.
const isBreakGlassArmed = (flag: string | undefined): boolean => flag === 'true';

export const resolveAdminDbMode = (env: AdminDbEnv): AdminDbModeDecision => {
  const url = env.ADMIN_DATABASE_URL;

  // Empty string is treated as unset (falls through to break-glass/fail).
  if (url !== undefined && url !== '') {
    if (!isPostgresUrl(url)) {
      return {
        mode: 'fail',
        reason:
          'ADMIN_DATABASE_URL is set but is not a postgres:// or postgresql:// connection string. ' +
          'Fix the URL — an invalid trust-plane target is never degraded to the main DB.',
      };
    }
    return { mode: 'dedicated', reason: 'ADMIN_DATABASE_URL is set' };
  }

  if (isBreakGlassArmed(env.ADMIN_DB_BREAK_GLASS)) {
    return {
      mode: 'break-glass',
      reason:
        "ADMIN_DATABASE_URL is unset and ADMIN_DB_BREAK_GLASS='true' — degrading audit writes to the main DB",
    };
  }

  return {
    mode: 'fail',
    reason:
      'ADMIN_DATABASE_URL is not set. The Admin PG (trust plane) is required in every deployment mode. ' +
      "Set ADMIN_DATABASE_URL to the dedicated admin Postgres, or — as an emergency rollback only — set ADMIN_DB_BREAK_GLASS='true' to permit audit writes to the main DB.",
  };
};

export interface AdminPoolConfig {
  connectionString: string;
  ssl: false | { rejectUnauthorized: false };
  max: number;
  keepAlive: true;
  keepAliveInitialDelayMillis: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}

const DEFAULT_POOL_MAX = 10;

const resolvePoolMax = (raw: string | undefined): number => {
  if (!raw) return DEFAULT_POOL_MAX;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_POOL_MAX;
};

// Mirrors the main pool settings in db.ts (ssl semantics, keepAlive, timeouts).
export const resolveAdminPoolConfig = (env: AdminDbEnv): AdminPoolConfig => ({
  connectionString: env.ADMIN_DATABASE_URL ?? '',
  ssl: env.ADMIN_DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: resolvePoolMax(env.ADMIN_DB_POOL_MAX),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  idleTimeoutMillis: 600000,
  connectionTimeoutMillis: 10000,
});

export type AdminMigrateDecision =
  | { ok: true; poolConfig: AdminPoolConfig }
  | { ok: false; reason: string };

/**
 * Env contract for the migrate/provision one-shots (#890 Phase 2, leaf 0).
 * The runtime ADMIN_DATABASE_URL is a least-privilege LOGIN (admin_app etc.),
 * which cannot run DDL — so the owner-credential path gets its own variable,
 * ADMIN_DATABASE_URL_MIGRATE, that never reaches any runtime service (compose
 * hands it to the migrate one-shot only; on Fly it is passed to the one-shot
 * machine, not stored in any app's runtime secrets).
 */
export interface AdminMigrateEnv extends AdminDbEnv {
  ADMIN_DATABASE_URL_MIGRATE?: string | undefined;
}

/**
 * Prefer the dedicated migrate URL when set (empty string = unset, matching
 * the ADMIN_DATABASE_URL contract). Invalid values are NOT silently skipped —
 * they flow into resolveAdminDbMode and fail there, so a misconfigured
 * migrate URL can never fall back to running DDL as the runtime login.
 */
export const resolveAdminMigrateEnv = (env: AdminMigrateEnv): AdminDbEnv => {
  const migrateUrl = env.ADMIN_DATABASE_URL_MIGRATE;
  if (migrateUrl !== undefined && migrateUrl !== '') {
    return { ...env, ADMIN_DATABASE_URL: migrateUrl };
  }
  return env;
};

/**
 * db:migrate:admin gate — only 'dedicated' may migrate. Break-glass degrades
 * audit WRITES to the main DB at runtime, but running admin migrations there
 * would plant the drizzle_admin journal inside the app plane, so it refuses.
 */
export const resolveAdminMigrateDecision = (env: AdminMigrateEnv): AdminMigrateDecision => {
  const resolvedEnv = resolveAdminMigrateEnv(env);
  const decision = resolveAdminDbMode(resolvedEnv);
  if (decision.mode === 'break-glass') {
    return {
      ok: false,
      reason:
        'admin migrations never run under break-glass — they target only a dedicated Admin PG. ' +
        'Set ADMIN_DATABASE_URL to the trust-plane database.',
    };
  }
  if (decision.mode === 'fail') {
    return { ok: false, reason: decision.reason };
  }
  return { ok: true, poolConfig: resolveAdminPoolConfig(resolvedEnv) };
};

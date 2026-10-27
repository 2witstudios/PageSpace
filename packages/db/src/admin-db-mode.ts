/**
 * Pure decision logic for the Admin PG (trust plane) connection registry
 * (#890). No I/O, no process.env reads — callers pass env values in.
 *
 * FIVE-state contract (post prod audit-write incident):
 *   URL set + VALID postgres URL                    → 'dedicated'
 *   URL set + INVALID URL                           → 'fail'   (positive misconfig — stop)
 *   URL unset + AUDIT_TRUST_PLANE_REQUIRED='true'   → 'fail'   (declared but not configured)
 *   URL unset + ADMIN_DB_BREAK_GLASS='true'         → 'break-glass' (main DB + LOUD alert)
 *   URL unset + neither flag                        → 'main-db' (DEFAULT: main DB, SILENT)
 *
 * Precedence when several apply:
 *   invalid-URL fail > TRUST_PLANE_REQUIRED fail > break-glass > main-db.
 *
 * Why 'main-db' is the default: the trust plane (dedicated Admin PG) has not
 * been adopted in every deployment. The pre-adoption behavior is exactly the
 * pre-epic one — audit rows live in the MAIN application database. Making an
 * unconfigured ADMIN_DATABASE_URL resolve to 'fail' broke that silently: every
 * audit write threw and was swallowed by the fire-and-forget audit() wrapper,
 * so security audit logging stopped in prod with no signal. 'main-db' restores
 * the silent, working default; loud failure is now OPT-IN via
 * AUDIT_TRUST_PLANE_REQUIRED='true' (declare you want the trust plane and it
 * fails closed when unconfigured), and break-glass remains a purely explicit
 * emergency override that keeps the loud alert.
 *
 * A set-but-invalid URL is always 'fail', even with a flag armed: a positive
 * misconfiguration must stop, never silently degrade to the main DB.
 */

export interface AdminDbEnv {
  ADMIN_DATABASE_URL?: string | undefined;
  ADMIN_DATABASE_SSL?: string | undefined;
  ADMIN_DB_POOL_MAX?: string | undefined;
  ADMIN_DB_BREAK_GLASS?: string | undefined;
  /**
   * Opt-in enforcement: when exactly 'true' AND ADMIN_DATABASE_URL is unset,
   * the mode is 'fail' (fail closed) instead of the silent 'main-db' default.
   * Set this only in deployments that HAVE adopted the trust plane and want a
   * missing URL to halt rather than silently fall back to the main DB.
   */
  AUDIT_TRUST_PLANE_REQUIRED?: string | undefined;
}

export type AdminDbModeName = 'dedicated' | 'break-glass' | 'main-db' | 'fail';

export interface AdminDbModeDecision {
  mode: AdminDbModeName;
  reason: string;
}

const isPostgresUrl = (url: string): boolean =>
  url.startsWith('postgresql://') || url.startsWith('postgres://');

// Fail-closed: only the exact string 'true' arms a flag. 'TRUE', '1',
// ' true ', '' etc. do not — mirrors the serverEnvSchema contract.
const isArmed = (flag: string | undefined): boolean => flag === 'true';

export const resolveAdminDbMode = (env: AdminDbEnv): AdminDbModeDecision => {
  const url = env.ADMIN_DATABASE_URL;

  // Empty string is treated as unset (falls through to the URL-unset ladder).
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

  // URL unset. Enforcement is opt-in and wins over both the emergency override
  // and the silent default: an operator who declared AUDIT_TRUST_PLANE_REQUIRED
  // wants the trust plane, so a missing URL must halt loudly.
  if (isArmed(env.AUDIT_TRUST_PLANE_REQUIRED)) {
    return {
      mode: 'fail',
      reason:
        "AUDIT_TRUST_PLANE_REQUIRED='true' but ADMIN_DATABASE_URL is not set. " +
        'Enforcement was requested without a dedicated Admin PG configured — set ADMIN_DATABASE_URL ' +
        'to the trust-plane database, or unset AUDIT_TRUST_PLANE_REQUIRED to run on the main DB.',
    };
  }

  if (isArmed(env.ADMIN_DB_BREAK_GLASS)) {
    return {
      mode: 'break-glass',
      reason:
        "ADMIN_DATABASE_URL is unset and ADMIN_DB_BREAK_GLASS='true' — degrading audit writes to the main DB",
    };
  }

  return {
    mode: 'main-db',
    reason:
      'ADMIN_DATABASE_URL is not set and the trust plane is not required — audit writes use the main ' +
      'application database (the pre-trust-plane default). Set ADMIN_DATABASE_URL to adopt the dedicated ' +
      "Admin PG, or AUDIT_TRUST_PLANE_REQUIRED='true' to fail closed when it is unconfigured.",
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
 * db:migrate:admin gate — only 'dedicated' may migrate. Break-glass and the
 * main-db default both degrade audit WRITES to the main DB at runtime, but
 * running admin migrations there would plant the drizzle_admin journal inside
 * the app plane, so both refuse. 'fail' surfaces its actionable reason.
 */
export const resolveAdminMigrateDecision = (env: AdminMigrateEnv): AdminMigrateDecision => {
  const resolvedEnv = resolveAdminMigrateEnv(env);
  const decision = resolveAdminDbMode(resolvedEnv);
  if (decision.mode === 'fail') {
    return { ok: false, reason: decision.reason };
  }
  if (decision.mode === 'break-glass' || decision.mode === 'main-db') {
    return {
      ok: false,
      reason:
        `admin migrations never run under ${decision.mode} — they target only a dedicated Admin PG. ` +
        'Set ADMIN_DATABASE_URL to the trust-plane database.',
    };
  }
  return { ok: true, poolConfig: resolveAdminPoolConfig(resolvedEnv) };
};

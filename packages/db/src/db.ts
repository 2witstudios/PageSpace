import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema';
import { registerPool, getPoolStats } from './pool-stats';
import 'dotenv/config';

// Shared connection tuning for every pool this module creates — a fresh
// `connectionString`/`max` get spread in per-pool, everything else (ssl,
// keepalive, timeouts) stays identical so the pools can't silently drift.
function basePoolConfig() {
  return {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? ({ rejectUnauthorized: false } as const) : false,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    idleTimeoutMillis: 600000,
    connectionTimeoutMillis: 10000,
  };
}

// statement_timeout/lock_timeout for the main pool ONLY — every application
// query goes through `db`, so a runaway query or a lock-wait pileup fails
// fast instead of holding a connection (and locks) indefinitely. Deliberately
// NOT part of basePoolConfig(): the advisory-lock pool below must never get
// lock_timeout (see its doc comment). A call site that legitimately needs
// longer than statement_timeout can still opt out per-transaction via
// `set_config('statement_timeout', ..., true)` — see drive-search-service.ts.
const APP_STATEMENT_TIMEOUT_MS = 15000;
const APP_LOCK_TIMEOUT_MS = 5000;

export function buildAppPoolOptions(): string {
  return `-c statement_timeout=${APP_STATEMENT_TIMEOUT_MS} -c lock_timeout=${APP_LOCK_TIMEOUT_MS}`;
}

// Exported for the adminDb break-glass path (admin-db.ts), which binds an
// admin-schema client over this same pool — no second connection pool.
export const pool = new Pool({
  ...basePoolConfig(),
  max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 10,
  options: buildAppPoolOptions(),
});

// Prevent uncaughtException spam when Fly's network drops idle connections
pool.on('error', (_err, _client) => {});

registerPool(pool);

export { getPoolStats };
/**
 * Explicitly annotated as `NodePgDatabase<typeof schema>` (matching
 * `getMigrationDb()` below) rather than inferred: drizzle-orm 0.45's
 * `drizzle()` returns `NodePgDatabase<TSchema> & { $client: Pool }`, and that
 * `$client` intersection is not carried by a `PgTransaction`. Without this
 * annotation every helper that types its handle as `typeof db` — the repo-wide
 * convention for "singleton or transaction" — would reject the `tx` passed
 * down from `db.transaction()`. Nothing in the monorepo uses `db.$client`;
 * callers needing the raw pool import `pool` directly from this module.
 */
export const db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

/**
 * Dedicated pool for out-of-band Postgres advisory locks (e.g. the
 * machine-storage reconcile serialization lock, via `@pagespace/db/advisory-lock`)
 * — deliberately SEPARATE from `pool` above. A caller that holds a
 * session-level advisory lock connection for an extended duration (the whole
 * span of a background job, not a single query) must never pin a connection
 * from the SAME pool Drizzle's `db` draws from: in a tightly configured
 * deployment (DB_POOL_MAX=1) that would starve every other `db` query for
 * the lock's entire hold time — a self-inflicted deadlock, independent of
 * how `DB_POOL_MAX` happens to be set. This pool only ever holds locks; it
 * never runs application queries, so `max` need only cover one lock holder
 * plus a handful of contenders' non-blocking try-lock probes (each releases
 * immediately on a busy result) — matching the main pool's default headroom
 * keeps a burst of concurrent callers (multiple containers, a manual
 * trigger racing the cron) from queuing on `connect()` and timing out
 * instead of getting a fast, clean `lock_busy`.
 *
 * Lazily constructed (mirrors apps/processor/src/db.ts's
 * `getAdminPoolForWorker()`): `packages/db/db` is imported by every app in
 * the monorepo, but only advisory-lock consumers ever call this — eagerly
 * constructing a second `pg.Pool` at module load would pay connection setup
 * for every process that never uses it.
 */
let advisoryLockPool: Pool | null = null;

export function getAdvisoryLockPool(): Pool {
  if (!advisoryLockPool) {
    advisoryLockPool = new Pool({ ...basePoolConfig(), max: 10 });
    advisoryLockPool.on('error', (_err, _client) => {});
    registerPool(advisoryLockPool, 'advisory-lock');
  }
  return advisoryLockPool;
}

/**
 * Dedicated pool for the main-DB migration entrypoint (migrate.ts) and other
 * one-shot maintenance/backfill scripts (e.g. migrate-pending-invites.ts) —
 * deliberately built from basePoolConfig() with NO `options`, so it never
 * inherits the app pool's statement_timeout/lock_timeout. Migrations run DDL
 * (index builds, table rewrites) that can legitimately run past 15s on a
 * populated table, and can legitimately queue behind a lock held by an
 * in-flight app transaction for longer than 5s — applying the app pool's
 * request-serving limits there would abort a migration mid-run and block
 * deployment instead of completing it. `max: 1` matches these scripts'
 * actual concurrency: each runs its statements sequentially on a single
 * connection, never in parallel.
 *
 * Lazily constructed like getAdvisoryLockPool(): only migration/backfill
 * scripts ever call this, and each is a short-lived process that exits when
 * done, so it isn't registered with pool-stats (nothing long-running is ever
 * around to report on it).
 */
let migrationPool: Pool | null = null;

export function getMigrationPool(): Pool {
  if (!migrationPool) {
    migrationPool = new Pool({ ...basePoolConfig(), max: 1 });
    migrationPool.on('error', (_err, _client) => {});
  }
  return migrationPool;
}

/**
 * Schema-bound drizzle client over getMigrationPool() — the single
 * entrypoint one-shot maintenance/backfill scripts (scripts/*.ts) should
 * import instead of `db`, so they never inherit the app pool's
 * statement_timeout/lock_timeout on a large table's bulk update/aggregate
 * query. Schema-bound (unlike the plain `drizzle(migrationPool)` calls in
 * migrate.ts/migrate-pending-invites.ts) because several backfill scripts
 * use the `db.query.*` relational API, not just the query builder.
 *
 * Lazy + memoized like getMigrationPool() itself — see that function's doc
 * comment for why this can't be an eagerly-constructed module-level const.
 */
let migrationDb: NodePgDatabase<typeof schema> | null = null;

export function getMigrationDb(): NodePgDatabase<typeof schema> {
  if (!migrationDb) {
    migrationDb = drizzle(getMigrationPool(), { schema });
  }
  return migrationDb;
}

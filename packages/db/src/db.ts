import { drizzle } from 'drizzle-orm/node-postgres';
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

// Exported for the adminDb break-glass path (admin-db.ts), which binds an
// admin-schema client over this same pool — no second connection pool.
export const pool = new Pool({
  ...basePoolConfig(),
  max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 10,
});

// Prevent uncaughtException spam when Fly's network drops idle connections
pool.on('error', (_err, _client) => {});

registerPool(pool);

export { getPoolStats };
export const db = drizzle(pool, { schema });

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

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema';
import { registerPool, getPoolStats } from './pool-stats';
import 'dotenv/config';

// Exported for the adminDb break-glass path (admin-db.ts), which binds an
// admin-schema client over this same pool — no second connection pool.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: process.env.DB_POOL_MAX ? parseInt(process.env.DB_POOL_MAX, 10) : 10,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  idleTimeoutMillis: 600000,
  connectionTimeoutMillis: 10000,
});

// Prevent uncaughtException spam when Fly's network drops idle connections
pool.on('error', (_err, _client) => {});

registerPool(pool);

export { getPoolStats };
export const db = drizzle(pool, { schema });

/**
 * Dedicated small pool for out-of-band Postgres advisory locks (e.g. the
 * machine-storage reconcile serialization lock) — deliberately SEPARATE from
 * `pool` above. A caller that holds a session-level advisory lock connection
 * for an extended duration (the whole span of a background job, not a single
 * query) must never pin a connection from the SAME pool Drizzle's `db` draws
 * from: in a tightly configured deployment (DB_POOL_MAX=1) that would starve
 * every other `db` query for the lock's entire hold time — a self-inflicted
 * deadlock, independent of how `DB_POOL_MAX` happens to be set. This pool
 * only ever holds locks; it never runs application queries, so a small max
 * comfortably covers one lock holder plus a few contenders' non-blocking
 * try-lock probes (each releases immediately on a busy result).
 */
export const advisoryLockPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 3,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  idleTimeoutMillis: 600000,
  connectionTimeoutMillis: 10000,
});
advisoryLockPool.on('error', (_err, _client) => {});
registerPool(advisoryLockPool, 'advisory-lock');

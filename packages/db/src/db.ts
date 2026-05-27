import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema';
import { registerPool, getPoolStats } from './pool-stats';
import 'dotenv/config';

const pool = new Pool({
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

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema';
import { registerPoolEvents, getPoolStats } from './pool-stats';
import 'dotenv/config';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

registerPoolEvents(pool);

export { getPoolStats };
export const db = drizzle(pool, { schema });

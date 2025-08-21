import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { schema } from './schema';
import 'dotenv/config';

// Re-export commonly used drizzle-orm functions
export {
  eq, and, or, not, inArray, sql, asc, desc, count, sum, avg, max, min,
  like, ilike, exists, between, gt, gte, lt, lte, ne, isNull, isNotNull
} from 'drizzle-orm';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
});

export const db = drizzle(pool, { schema });

// Export schema for external use
export * from './schema';
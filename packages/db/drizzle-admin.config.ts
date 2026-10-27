import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';
import path from 'path';

// Load environment variables from the root .env file
config({ path: path.resolve(__dirname, '../../.env') });

/**
 * Drizzle config for the Admin PG (trust plane) — #890 Phase 1.
 *
 * Separate schema barrel, separate journal (./drizzle-admin), separate
 * database (ADMIN_DATABASE_URL) — the main-DB pipeline (root drizzle.config.ts
 * → ./drizzle) is never touched by admin generate/migrate and vice versa.
 * Pattern: apps/control-plane/drizzle.config.ts.
 */
export default defineConfig({
  schema: './src/admin-schema.ts',
  out: './drizzle-admin',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.ADMIN_DATABASE_URL || 'postgresql://localhost:5432/pagespace_admin',
  },
});

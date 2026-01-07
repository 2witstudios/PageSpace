#!/usr/bin/env tsx
import { config } from 'dotenv';

// Load .env from current working directory (run from project root)
config();

// Fix DATABASE_URL for local execution (Docker uses "postgres" hostname, local needs "localhost")
if (process.env.DATABASE_URL) {
  const originalUrl = process.env.DATABASE_URL;
  // Replace Docker hostname with localhost for local script execution
  process.env.DATABASE_URL = originalUrl
    .replace('://postgres:', '://localhost:')
    .replace('@postgres/', '@localhost/')
    .replace('@postgres:', '@localhost:');

  if (originalUrl !== process.env.DATABASE_URL) {
    console.log('Note: Adjusted DATABASE_URL for local execution (postgres -> localhost)\n');
  }
}

/**
 * Seed Load Test User
 *
 * Creates a dedicated user for load testing. This user should only exist
 * in development/staging environments, never in production.
 *
 * Usage:
 *   # From project root:
 *   node_modules/.pnpm/node_modules/.bin/tsx scripts/seed-loadtest-user.ts
 *
 *   # Or add to package.json scripts:
 *   pnpm seed:loadtest
 *
 *   # With custom credentials
 *   TEST_EMAIL=mytest@example.com TEST_PASSWORD=MyPass123! pnpm seed:loadtest
 *
 * The user will be created with:
 *   - Email: loadtest@example.com (or TEST_EMAIL env var)
 *   - Password: LoadTest123! (or TEST_PASSWORD env var)
 *   - Name: Load Test User
 */

// Dynamic import after DATABASE_URL is fixed
async function main() {
  const { db, users } = await import('@pagespace/db');
  const { eq } = await import('drizzle-orm');
  const bcrypt = await import('bcryptjs');
  const { createId } = await import('@paralleldrive/cuid2');

  const DEFAULT_EMAIL = 'loadtest@example.com';
  const DEFAULT_PASSWORD = 'LoadTest123!';
  const DEFAULT_NAME = 'Load Test User';

  const email = process.env.TEST_EMAIL || DEFAULT_EMAIL;
  const password = process.env.TEST_PASSWORD || DEFAULT_PASSWORD;
  const name = process.env.TEST_NAME || DEFAULT_NAME;

  console.log('Load Test User Seeder');
  console.log('=====================\n');

  // Check if running in production
  if (process.env.NODE_ENV === 'production') {
    console.error('ERROR: Cannot seed load test user in production environment!');
    process.exit(1);
  }

  try {
    // Check if user already exists
    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      console.log(`User already exists: ${email}`);
      console.log(`  ID: ${existingUser.id}`);
      console.log(`  Name: ${existingUser.name}`);
      console.log('\nTo update password, delete the user first and re-run this script.');
      process.exit(0);
    }

    // Hash password
    const hashedPassword = await bcrypt.default.hash(password, 12);

    // Create user
    const userId = createId();
    await db.insert(users).values({
      id: userId,
      email,
      name,
      password: hashedPassword,
      provider: 'email',
      emailVerified: new Date(), // Mark as verified for testing
      role: 'user',
      tokenVersion: 0,
      subscriptionTier: 'free',
    });

    console.log('Load test user created successfully!\n');
    console.log('Credentials:');
    console.log(`  Email: ${email}`);
    console.log(`  Password: ${password}`);
    console.log(`  User ID: ${userId}`);
    console.log('\nYou can now run load tests with:');
    console.log(`  k6 run tests/load/auth-baseline.k6.js`);

    process.exit(0);
  } catch (error) {
    console.error('Failed to create load test user:', error);
    process.exit(1);
  }
}

main();

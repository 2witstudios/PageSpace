#!/usr/bin/env node
/**
 * Seed script: create a load-test user + session and write tests/load/.k6-auth.json
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node tests/load/scripts/create-k6-auth.mjs
 *
 * The script is idempotent: if the test user already exists it reuses it.
 * Written as plain ESM to avoid the TypeScript compilation step in CI.
 */
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';

const { Client } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const TEST_USER_EMAIL = 'k6-load-test@pagespace.internal';
const TEST_USER_NAME = 'k6 Load Test';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function generateOpaqueToken() {
  const randomPart = randomBytes(32).toString('base64url');
  const token = `ps_sess_${randomPart}`;
  const tokenHash = createHash('sha3-256').update(token).digest('hex');
  const tokenPrefix = token.substring(0, 12);
  return { token, tokenHash, tokenPrefix };
}

function createCuid() {
  // Minimal CUID2-compatible ID (timestamp + random)
  const ts = Date.now().toString(36);
  const rand = randomBytes(10).toString('base64url').replace(/[^a-z0-9]/gi, '').substring(0, 14);
  return `c${ts}${rand}`.substring(0, 24);
}

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  try {
    // 1. Upsert test user
    const userId = createCuid();
    const upsertUser = await client.query(
      `INSERT INTO users (id, name, email, "emailVerified", provider, "tokenVersion", role, "adminRoleVersion",
        "currentAiProvider", "currentAiModel", "storageUsedBytes", "activeUploads", "subscriptionTier",
        "failedLoginAttempts", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NOW(), 'email', 0, 'user', 0, 'pagespace', 'glm-4.7', 0, 0, 'free', 0, NOW(), NOW())
       ON CONFLICT (email) DO UPDATE SET "updatedAt" = NOW()
       RETURNING id, "tokenVersion", "adminRoleVersion"`,
      [userId, TEST_USER_NAME, TEST_USER_EMAIL]
    );
    const user = upsertUser.rows[0];
    console.log(`User: ${TEST_USER_EMAIL} (id=${user.id})`);

    // 2. Upsert personal drive
    const driveId = createCuid();
    const upsertDrive = await client.query(
      `INSERT INTO drives (id, name, slug, "ownerId", "isTrashed", "updatedAt")
       VALUES ($1, 'Personal', 'personal', $2, false, NOW())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [driveId, user.id]
    );

    let resolvedDriveId;
    if (upsertDrive.rows.length > 0) {
      resolvedDriveId = upsertDrive.rows[0].id;
    } else {
      // Drive already exists — find it
      const existing = await client.query(
        `SELECT id FROM drives WHERE "ownerId" = $1 ORDER BY "updatedAt" ASC LIMIT 1`,
        [user.id]
      );
      resolvedDriveId = existing.rows[0]?.id ?? null;
    }
    console.log(`Drive: ${resolvedDriveId}`);

    // 3. Create session
    const { token, tokenHash, tokenPrefix } = generateOpaqueToken();
    const sessionId = createCuid();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    await client.query(
      `INSERT INTO sessions (id, token_hash, token_prefix, user_id, type, scopes,
        token_version, admin_role_version, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 'user', ARRAY[]::text[], $5, $6, $7, NOW())`,
      [sessionId, tokenHash, tokenPrefix, user.id, user.tokenVersion, user.adminRoleVersion, expiresAt]
    );
    console.log(`Session created (expires ${expiresAt.toISOString()})`);

    // 4. Write .k6-auth.json
    const __dir = dirname(fileURLToPath(import.meta.url));
    const outPath = resolve(__dir, '../.k6-auth.json');
    writeFileSync(outPath, JSON.stringify({ sessionToken: token, driveId: resolvedDriveId }, null, 2));
    console.log(`Written: ${outPath}`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

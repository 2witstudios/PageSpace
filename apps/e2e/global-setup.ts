import { randomBytes, createHash } from 'crypto';
import { Pool } from 'pg';
import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenvConfig({ path: path.resolve(__dirname, '../../.env') });

function generateSessionToken(): { token: string; tokenHash: string; tokenPrefix: string } {
  const randomPart = randomBytes(32).toString('base64url');
  const token = `ps_sess_${randomPart}`;
  const tokenHash = createHash('sha3-256').update(token).digest('hex');
  return { token, tokenHash, tokenPrefix: token.substring(0, 12) };
}

export default async function globalSetup() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const email = `e2e-${Date.now()}@pagespace-test.local`;
    const userId = randomBytes(16).toString('hex');
    await client.query(
      `INSERT INTO users (id, name, email, "emailVerified", provider, "tokenVersion", role, "adminRoleVersion",
        "currentAiProvider", "currentAiModel", "storageUsedBytes", "activeUploads", "subscriptionTier",
        "failedLoginAttempts", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NOW(), 'email', 0, 'user', 0, 'pagespace', 'glm-4.7', 0, 0, 'free', 0, NOW(), NOW())`,
      [userId, 'E2E Test User', email],
    );

    const driveName = `E2E Drive ${Date.now()}`;
    const driveSlug = driveName.toLowerCase().replace(/\s+/g, '-');
    const driveId = randomBytes(16).toString('hex');
    await client.query(
      `INSERT INTO drives (id, name, slug, "ownerId", "isTrashed", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, false, NOW(), NOW())`,
      [driveId, driveName, driveSlug, userId],
    );

    const { token, tokenHash, tokenPrefix } = generateSessionToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO sessions (id, token_hash, token_prefix, user_id, type, scopes, token_version,
        admin_role_version, expires_at, created_at)
       VALUES ($1, $2, $3, $4, 'user', ARRAY[]::text[], 0, 0, $5, NOW())`,
      [randomBytes(16).toString('hex'), tokenHash, tokenPrefix, userId, expiresAt],
    );

    const storageState = {
      cookies: [
        {
          name: 'session',
          value: token,
          domain: 'localhost',
          path: '/',
          expires: Math.floor(expiresAt.getTime() / 1000),
          httpOnly: true,
          secure: false,
          sameSite: 'Strict' as const,
        },
      ],
      origins: [] as string[],
    };

    fs.writeFileSync(
      path.resolve(__dirname, 'storageState.json'),
      JSON.stringify(storageState, null, 2),
    );

    fs.writeFileSync(
      path.resolve(__dirname, '.seed-state.json'),
      JSON.stringify({ userId, driveId }),
    );
  } finally {
    client.release();
    await pool.end();
  }
}

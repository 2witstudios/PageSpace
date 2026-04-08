/**
 * PKCE (Proof Key for Code Exchange) for OAuth 2.1
 *
 * Generates code_verifier/code_challenge pairs and stores the verifier
 * server-side in Redis. The callback route retrieves and consumes the
 * verifier to complete the token exchange — the authorization code alone
 * is useless without it.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7636
 * @module @pagespace/lib/auth/pkce
 */

import crypto from 'crypto';
import { tryGetSecurityRedisClient } from '../security/security-redis';
import { loggers } from '../logging/logger-config';

const PKCE_TTL_SECONDS = 600; // 10 minutes — enough for OAuth round-trip
const PKCE_PREFIX = 'oauth:pkce:';

/**
 * Generate PKCE code_verifier and code_challenge (S256 method).
 * Stores the verifier in Redis keyed by the SHA-256 hash of the state param.
 *
 * Returns null if Redis is unavailable (PKCE degrades gracefully — the OAuth
 * flow still works, just without the extra PKCE layer).
 */
export async function generatePKCE(stateParam: string): Promise<{
  codeChallenge: string;
  codeChallengeMethod: 'S256';
} | null> {
  const redis = await tryGetSecurityRedisClient();
  if (!redis) {
    loggers.auth.warn('PKCE: Redis unavailable, skipping code challenge generation');
    return null;
  }

  // Generate 32-byte random verifier (base64url, 43 chars)
  const codeVerifier = crypto.randomBytes(32).toString('base64url');

  // S256: SHA-256 hash of verifier, base64url-encoded
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  // Store verifier keyed by state hash (state is the correlation key)
  const stateHash = crypto.createHash('sha256').update(stateParam).digest('hex');
  await redis.set(`${PKCE_PREFIX}${stateHash}`, codeVerifier, 'EX', PKCE_TTL_SECONDS);

  return { codeChallenge, codeChallengeMethod: 'S256' };
}

/**
 * Retrieve and consume the PKCE code_verifier for a given state.
 * Returns null if not found (expired, already consumed, or PKCE wasn't used).
 * Deletes after retrieval to prevent reuse.
 */
export async function consumePKCEVerifier(stateParam: string): Promise<string | null> {
  const redis = await tryGetSecurityRedisClient();
  if (!redis) return null;

  const stateHash = crypto.createHash('sha256').update(stateParam).digest('hex');
  const key = `${PKCE_PREFIX}${stateHash}`;

  // Atomic get-and-delete
  const verifier = await redis.get(key);
  if (verifier) {
    await redis.del(key);
  }
  return verifier;
}

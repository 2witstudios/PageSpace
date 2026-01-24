/**
 * One-Time Exchange Codes for Desktop OAuth
 *
 * Implements secure token handoff for desktop OAuth flows using
 * the standard OAuth authorization code pattern.
 *
 * Flow:
 * 1. OAuth callback generates one-time code, stores tokens in Redis
 * 2. Redirects to pagespace://auth-exchange?code=<code>
 * 3. Desktop app POSTs code to /api/auth/desktop/exchange
 * 4. Server returns tokens in response body, deletes code (one-time use)
 *
 * Security benefits:
 * - Tokens never appear in URLs (no nginx log leakage)
 * - Codes are one-time use (deleted after consumption)
 * - Short TTL (5 minutes)
 * - Codes are hashed in Redis (defense in depth)
 *
 * @module @pagespace/lib/auth/exchange-codes
 */

import { randomBytes } from 'crypto';
import { hashToken } from './token-utils';
import { tryGetSecurityRedisClient } from '../security/security-redis';
import { loggers } from '../logging/logger-config';

const EXCHANGE_CODE_PREFIX = 'auth:exchange:';
const EXCHANGE_CODE_TTL_SECONDS = 300; // 5 minutes

/**
 * Data stored with an exchange code in Redis.
 */
export interface ExchangeCodeData {
  sessionToken: string;
  csrfToken: string;
  deviceToken: string;
  provider: string;
  userId: string;
  createdAt: number;
}

/**
 * Create a one-time exchange code and store associated tokens in Redis.
 *
 * @param data - Token data to store (sessionToken, csrfToken, deviceToken, etc.)
 * @returns The one-time exchange code (base64url encoded)
 * @throws If Redis is unavailable in production
 */
export async function createExchangeCode(data: ExchangeCodeData): Promise<string> {
  const redis = await tryGetSecurityRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Cannot create exchange code: Redis unavailable in production');
    }
    // In development, throw to fail fast
    throw new Error('Redis required for exchange codes');
  }

  // Generate cryptographically secure random code
  const code = randomBytes(32).toString('base64url');
  const codeHash = hashToken(code);

  const key = `${EXCHANGE_CODE_PREFIX}${codeHash}`;

  await redis.setex(key, EXCHANGE_CODE_TTL_SECONDS, JSON.stringify(data));

  loggers.auth.info('Exchange code created', {
    userId: data.userId,
    provider: data.provider,
    ttlSeconds: EXCHANGE_CODE_TTL_SECONDS,
  });

  return code;
}

/**
 * Consume a one-time exchange code and retrieve the associated tokens.
 *
 * The code is deleted immediately after retrieval (one-time use).
 *
 * @param code - The exchange code from the deep link
 * @returns Token data if valid, null if code is invalid/expired/already used
 */
export async function consumeExchangeCode(code: string): Promise<ExchangeCodeData | null> {
  if (!code || typeof code !== 'string') {
    return null;
  }

  const redis = await tryGetSecurityRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV === 'production') {
      loggers.auth.error('Cannot consume exchange code: Redis unavailable in production');
    }
    return null;
  }

  const codeHash = hashToken(code);
  const key = `${EXCHANGE_CODE_PREFIX}${codeHash}`;

  // Get and delete atomically using a Lua script
  // This prevents race conditions where the same code is used twice
  const luaScript = `
    local data = redis.call('GET', KEYS[1])
    if data then
      redis.call('DEL', KEYS[1])
    end
    return data
  `;

  const data = await redis.eval(luaScript, 1, key) as string | null;

  if (!data) {
    loggers.auth.warn('Exchange code invalid or expired', {
      codePrefix: code.substring(0, 8),
    });
    return null;
  }

  try {
    const parsed = JSON.parse(data) as ExchangeCodeData;

    loggers.auth.info('Exchange code consumed', {
      userId: parsed.userId,
      provider: parsed.provider,
    });

    return parsed;
  } catch (error) {
    loggers.auth.error('Failed to parse exchange code data', error as Error);
    return null;
  }
}

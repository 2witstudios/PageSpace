/**
 * One-Time Exchange Codes for Desktop OAuth
 *
 * Implements secure token handoff for desktop OAuth flows using
 * the standard OAuth authorization code pattern.
 *
 * Flow:
 * 1. OAuth callback generates one-time code, stores tokens in Postgres
 *    (auth_handoff_tokens, kind='exchange-code').
 * 2. Redirects to pagespace://auth-exchange?code=<code>
 * 3. Desktop app POSTs code to /api/auth/desktop/exchange
 * 4. Server returns tokens in response body, deletes code (one-time use).
 *
 * Security benefits:
 * - Tokens never appear in URLs (no nginx log leakage)
 * - Codes are one-time use (atomic DELETE … RETURNING)
 * - Short TTL (5 minutes)
 * - Codes are SHA3-256 hashed at rest (defense in depth)
 *
 * @module @pagespace/lib/auth/exchange-codes
 */

import { randomBytes } from 'crypto';
import { hashToken } from './token-utils';
import { db, authHandoffTokens, sql } from '@pagespace/db';
import { loggers } from '../logging/logger-config';

const EXCHANGE_CODE_KIND = 'exchange-code';
const EXCHANGE_CODE_TTL_SECONDS = 300; // 5 minutes

/**
 * Data stored with an exchange code in Postgres.
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
 * Create a one-time exchange code and store associated tokens in Postgres.
 *
 * @param data - Token data to store (sessionToken, csrfToken, deviceToken, etc.)
 * @returns The one-time exchange code (base64url encoded)
 * @throws If the DB is unavailable (in any environment — fail fast).
 */
export async function createExchangeCode(data: ExchangeCodeData): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  const codeHash = hashToken(code);
  const expiresAt = new Date(Date.now() + EXCHANGE_CODE_TTL_SECONDS * 1000);

  try {
    await db.insert(authHandoffTokens).values({
      tokenHash: codeHash,
      kind: EXCHANGE_CODE_KIND,
      payload: data,
      expiresAt,
    });
  } catch (error) {
    loggers.auth.error(
      'Cannot create exchange code: Postgres query failed',
      error as Error,
    );
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'Cannot create exchange code: Postgres unavailable in production',
      );
    }
    throw new Error('Postgres required for exchange codes');
  }

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
 * The code is deleted atomically during retrieval (single DELETE … RETURNING
 * round-trip — no select-then-delete race window).
 *
 * @param code - The exchange code from the deep link
 * @returns Token data if valid, null if code is invalid / expired / already
 *          used / DB unavailable. Never throws.
 */
export async function consumeExchangeCode(
  code: string,
): Promise<ExchangeCodeData | null> {
  if (!code || typeof code !== 'string') {
    return null;
  }

  const codeHash = hashToken(code);

  let payload: unknown;
  try {
    const result = await db.execute<{ payload: unknown }>(
      sql`DELETE FROM ${authHandoffTokens}
          WHERE ${authHandoffTokens.tokenHash} = ${codeHash}
            AND ${authHandoffTokens.kind} = ${EXCHANGE_CODE_KIND}
            AND ${authHandoffTokens.expiresAt} > now()
          RETURNING ${authHandoffTokens.payload} AS payload`,
    );
    payload = result.rows[0]?.payload;
  } catch (error) {
    if (process.env.NODE_ENV === 'production') {
      loggers.auth.error(
        'Cannot consume exchange code: Postgres unavailable in production',
        error as Error,
      );
    }
    return null;
  }

  if (!payload || typeof payload !== 'object') {
    loggers.auth.warn('Exchange code invalid or expired', {
      codePrefix: code.substring(0, 8),
    });
    return null;
  }

  const parsed = payload as ExchangeCodeData;
  loggers.auth.info('Exchange code consumed', {
    userId: parsed.userId,
    provider: parsed.provider,
  });
  return parsed;
}

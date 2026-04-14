/**
 * Passkey Register Handoff Tokens
 *
 * Short-lived, one-time tokens that hand an authenticated PageSpace user's
 * identity from the desktop (Electron) renderer to the system browser so the
 * external `/auth/external-register/*` endpoints can authorise a passkey
 * registration ceremony without a PageSpace session cookie.
 *
 * Flow:
 * 1. Authenticated Electron renderer POSTs to a mint endpoint, which calls
 *    `createPasskeyRegisterHandoff({ userId })` and receives the plaintext
 *    token.
 * 2. Renderer opens the system browser via `shell.openExternal` with the
 *    token in the URL.
 * 3. External options endpoint calls `peekPasskeyRegisterHandoff` (no delete
 *    — the verify step still needs it).
 * 4. External verify endpoint calls `consumePasskeyRegisterHandoff` which
 *    atomically reads and deletes (one-time use).
 *
 * Matches the security posture of `./exchange-codes`:
 * - 32-byte base64url token, SHA-256 hashed at rest
 * - 300s TTL
 * - Lua GET+DEL for atomic consume
 * - Fail-closed on create when Redis is unavailable; log-and-return-null on
 *   read paths.
 *
 * @module @pagespace/lib/auth/passkey-register-handoff
 */

import { randomBytes } from 'crypto';
import { hashToken } from './token-utils';
import { tryGetSecurityRedisClient } from '../security/security-redis';
import { loggers } from '../logging/logger-config';

const PASSKEY_REGISTER_HANDOFF_PREFIX = 'auth:passkey-register-handoff:';
const PASSKEY_REGISTER_HANDOFF_OPTIONS_PREFIX =
  'auth:passkey-register-handoff-options-issued:';
const PASSKEY_REGISTER_HANDOFF_TTL_SECONDS = 300;

export interface PasskeyRegisterHandoffData {
  userId: string;
  createdAt: number;
}

function keyFor(token: string): string {
  return `${PASSKEY_REGISTER_HANDOFF_PREFIX}${hashToken(token)}`;
}

function optionsMarkerKeyFor(token: string): string {
  return `${PASSKEY_REGISTER_HANDOFF_OPTIONS_PREFIX}${hashToken(token)}`;
}

/**
 * Create a one-time passkey register handoff token and store the associated
 * user identity in Redis.
 *
 * @throws if Redis is unavailable (in any environment — fail fast)
 */
export async function createPasskeyRegisterHandoff(
  input: { userId: string }
): Promise<string> {
  const redis = await tryGetSecurityRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'Cannot create passkey register handoff: Redis unavailable in production'
      );
    }
    throw new Error('Redis required for passkey register handoff');
  }

  const token = randomBytes(32).toString('base64url');
  const key = keyFor(token);
  const data: PasskeyRegisterHandoffData = {
    userId: input.userId,
    createdAt: Date.now(),
  };

  await redis.setex(
    key,
    PASSKEY_REGISTER_HANDOFF_TTL_SECONDS,
    JSON.stringify(data)
  );

  loggers.auth.info('Passkey register handoff created', {
    userId: input.userId,
    ttlSeconds: PASSKEY_REGISTER_HANDOFF_TTL_SECONDS,
  });

  return token;
}

/**
 * Non-destructive lookup. Returns the stored handoff data without deleting
 * the key. Used by the external options endpoint so the verify call still
 * finds a live token.
 *
 * Returns `null` for missing / expired / malformed tokens or when Redis is
 * unavailable — never throws.
 */
export async function peekPasskeyRegisterHandoff(
  token: string
): Promise<PasskeyRegisterHandoffData | null> {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const redis = await tryGetSecurityRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV === 'production') {
      loggers.auth.error(
        'Cannot peek passkey register handoff: Redis unavailable in production'
      );
    }
    return null;
  }

  const key = keyFor(token);

  let raw: string | null;
  try {
    raw = (await redis.get(key)) as string | null;
  } catch (error) {
    loggers.auth.error(
      'Passkey register handoff peek Redis error',
      error as Error
    );
    return null;
  }

  if (!raw) {
    loggers.auth.warn('Passkey register handoff peek miss', {
      tokenPrefix: token.substring(0, 8),
    });
    return null;
  }

  try {
    return JSON.parse(raw) as PasskeyRegisterHandoffData;
  } catch (error) {
    loggers.auth.error(
      'Failed to parse passkey register handoff data (peek)',
      error as Error
    );
    return null;
  }
}

/**
 * Atomically read and delete a passkey register handoff token. One-time use —
 * a second call returns `null`.
 *
 * Returns `null` for missing / expired / malformed tokens or when Redis is
 * unavailable — never throws.
 */
export async function consumePasskeyRegisterHandoff(
  token: string
): Promise<PasskeyRegisterHandoffData | null> {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const redis = await tryGetSecurityRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV === 'production') {
      loggers.auth.error(
        'Cannot consume passkey register handoff: Redis unavailable in production'
      );
    }
    return null;
  }

  const key = keyFor(token);

  const luaScript = `
    local data = redis.call('GET', KEYS[1])
    if data then
      redis.call('DEL', KEYS[1])
    end
    return data
  `;

  let raw: string | null;
  try {
    raw = (await redis.eval(luaScript, 1, key)) as string | null;
  } catch (error) {
    loggers.auth.error(
      'Passkey register handoff consume Redis error',
      error as Error
    );
    return null;
  }

  if (!raw) {
    loggers.auth.warn('Passkey register handoff invalid or already consumed', {
      tokenPrefix: token.substring(0, 8),
    });
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as PasskeyRegisterHandoffData;
    loggers.auth.info('Passkey register handoff consumed', {
      userId: parsed.userId,
    });
    return parsed;
  } catch (error) {
    loggers.auth.error(
      'Failed to parse passkey register handoff data (consume)',
      error as Error
    );
    return null;
  }
}

/**
 * One-options-per-handoff-token guard. Sets a short-lived marker the first
 * time a handoff token is used to issue WebAuthn registration options.
 * Returns `true` if the marker was set (first call — caller should proceed)
 * or `false` if the marker already existed (replay — caller should reject).
 *
 * Required because the options endpoint uses `peek` (non-destructive), so
 * without this guard a single minted handoff token could drive unbounded
 * `generateRegistrationOptions` calls within its TTL. The legitimate
 * ceremony calls options exactly once per minted token.
 *
 * Fails closed: any Redis unavailability or error returns `false`. A
 * transient Redis blip forces the client to re-mint, which is acceptable
 * (mint is session-authed + rate-limited) and strictly safer than opening
 * the replay window.
 */
export async function markPasskeyRegisterOptionsIssued(
  token: string
): Promise<boolean> {
  if (!token || typeof token !== 'string') {
    return false;
  }

  const redis = await tryGetSecurityRedisClient();

  if (!redis) {
    if (process.env.NODE_ENV === 'production') {
      loggers.auth.error(
        'Cannot mark passkey register options issued: Redis unavailable in production'
      );
    }
    return false;
  }

  const key = optionsMarkerKeyFor(token);

  try {
    const result = await redis.set(
      key,
      '1',
      'EX',
      PASSKEY_REGISTER_HANDOFF_TTL_SECONDS,
      'NX'
    );
    return result === 'OK';
  } catch (error) {
    loggers.auth.error(
      'Passkey register options marker Redis error',
      error as Error
    );
    return false;
  }
}

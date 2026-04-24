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
 * Storage: Postgres `auth_handoff_tokens`, kind='passkey-register-handoff'
 * for the primary token and kind='passkey-options-marker' for the
 * one-options-per-mint replay guard.
 *
 * Security posture:
 * - 32-byte base64url token, SHA3-256 hashed at rest
 * - 300s TTL
 * - Atomic DELETE … RETURNING for consume (no select-then-delete race)
 * - Fail-closed on create when DB is unavailable; log-and-return-null on
 *   read paths; fail-closed (return false) on the marker.
 *
 * @module @pagespace/lib/auth/passkey-register-handoff
 */

import { randomBytes } from 'crypto';
import { hashToken } from './token-utils';
import { db } from '@pagespace/db/db';
import { and, eq, sql } from '@pagespace/db/operators';
import { authHandoffTokens } from '@pagespace/db/schema/auth-handoff-tokens';
import { loggers } from '../logging/logger-config';

const PASSKEY_REGISTER_HANDOFF_KIND = 'passkey-register-handoff';
const PASSKEY_OPTIONS_MARKER_KIND = 'passkey-options-marker';
const PASSKEY_REGISTER_HANDOFF_TTL_SECONDS = 300;

export interface PasskeyRegisterHandoffData {
  userId: string;
  createdAt: number;
}

/**
 * Create a one-time passkey register handoff token and store the associated
 * user identity in Postgres.
 *
 * @throws if the DB is unavailable (in any environment — fail fast).
 */
export async function createPasskeyRegisterHandoff(
  input: { userId: string },
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const data: PasskeyRegisterHandoffData = {
    userId: input.userId,
    createdAt: Date.now(),
  };
  const expiresAt = new Date(
    Date.now() + PASSKEY_REGISTER_HANDOFF_TTL_SECONDS * 1000,
  );

  try {
    await db.insert(authHandoffTokens).values({
      tokenHash: hashToken(token),
      kind: PASSKEY_REGISTER_HANDOFF_KIND,
      payload: data,
      expiresAt,
    });
  } catch (error) {
    loggers.auth.error(
      'Cannot create passkey register handoff: Postgres query failed',
      error as Error,
    );
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'Cannot create passkey register handoff: Postgres unavailable in production',
      );
    }
    throw new Error('Postgres required for passkey register handoff');
  }

  loggers.auth.info('Passkey register handoff created', {
    userId: input.userId,
    ttlSeconds: PASSKEY_REGISTER_HANDOFF_TTL_SECONDS,
  });

  return token;
}

/**
 * Non-destructive lookup. Returns the stored handoff data without deleting
 * the row. Used by the external options endpoint so the verify call still
 * finds a live token.
 *
 * Returns `null` for missing / expired tokens or when the DB is unavailable
 * — never throws.
 */
export async function peekPasskeyRegisterHandoff(
  token: string,
): Promise<PasskeyRegisterHandoffData | null> {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const tokenHash = hashToken(token);

  let payload: unknown;
  try {
    const rows = await db
      .select({ payload: authHandoffTokens.payload })
      .from(authHandoffTokens)
      .where(
        and(
          eq(authHandoffTokens.tokenHash, tokenHash),
          eq(authHandoffTokens.kind, PASSKEY_REGISTER_HANDOFF_KIND),
          sql`${authHandoffTokens.expiresAt} > now()`,
        ),
      )
      .limit(1);
    payload = rows[0]?.payload;
  } catch (error) {
    loggers.auth.error(
      'Passkey register handoff peek DB error',
      error as Error,
    );
    return null;
  }

  if (!payload || typeof payload !== 'object') {
    loggers.auth.warn('Passkey register handoff peek miss', {
      tokenPrefix: token.substring(0, 8),
    });
    return null;
  }

  return payload as PasskeyRegisterHandoffData;
}

/**
 * Atomically read and delete a passkey register handoff token. One-time
 * use — a second call returns `null`.
 *
 * Returns `null` for missing / expired tokens or when the DB is unavailable
 * — never throws.
 */
export async function consumePasskeyRegisterHandoff(
  token: string,
): Promise<PasskeyRegisterHandoffData | null> {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const tokenHash = hashToken(token);

  let payload: unknown;
  try {
    const result = await db.execute<{ payload: unknown }>(
      sql`DELETE FROM ${authHandoffTokens}
          WHERE ${authHandoffTokens.tokenHash} = ${tokenHash}
            AND ${authHandoffTokens.kind} = ${PASSKEY_REGISTER_HANDOFF_KIND}
            AND ${authHandoffTokens.expiresAt} > now()
          RETURNING ${authHandoffTokens.payload} AS payload`,
    );
    payload = result.rows[0]?.payload;
  } catch (error) {
    loggers.auth.error(
      'Passkey register handoff consume DB error',
      error as Error,
    );
    return null;
  }

  if (!payload || typeof payload !== 'object') {
    loggers.auth.warn('Passkey register handoff invalid or already consumed', {
      tokenPrefix: token.substring(0, 8),
    });
    return null;
  }

  const parsed = payload as PasskeyRegisterHandoffData;
  loggers.auth.info('Passkey register handoff consumed', {
    userId: parsed.userId,
  });
  return parsed;
}

/**
 * One-options-per-handoff-token guard. Inserts a short-lived marker the
 * first time a handoff token is used to issue WebAuthn registration
 * options. Returns `true` if the marker was set (first call — caller
 * should proceed) or `false` if the marker already existed (replay —
 * caller should reject).
 *
 * Required because the options endpoint uses `peek` (non-destructive), so
 * without this guard a single minted handoff token could drive unbounded
 * `generateRegistrationOptions` calls within its TTL. The legitimate
 * ceremony calls options exactly once per minted token.
 *
 * Fails closed: any DB unavailability or error returns `false`. A
 * transient DB blip forces the client to re-mint, which is acceptable
 * (mint is session-authed + rate-limited) and strictly safer than opening
 * the replay window.
 */
export async function markPasskeyRegisterOptionsIssued(
  token: string,
): Promise<boolean> {
  if (!token || typeof token !== 'string') {
    return false;
  }

  const tokenHash = hashToken(token);
  const expiresAt = new Date(
    Date.now() + PASSKEY_REGISTER_HANDOFF_TTL_SECONDS * 1000,
  );

  try {
    const inserted = await db
      .insert(authHandoffTokens)
      .values({
        tokenHash,
        kind: PASSKEY_OPTIONS_MARKER_KIND,
        payload: {},
        expiresAt,
      })
      .onConflictDoNothing({
        target: [authHandoffTokens.tokenHash, authHandoffTokens.kind],
      })
      .returning({ tokenHash: authHandoffTokens.tokenHash });
    return inserted.length > 0;
  } catch (error) {
    loggers.auth.error(
      'Passkey register options marker DB error',
      error as Error,
    );
    return false;
  }
}

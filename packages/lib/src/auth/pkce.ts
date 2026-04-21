/**
 * PKCE (Proof Key for Code Exchange) for OAuth 2.1
 *
 * Generates code_verifier/code_challenge pairs and stores the verifier
 * server-side in Postgres (auth_handoff_tokens, kind='pkce'). The callback
 * route retrieves and consumes the verifier to complete the token exchange —
 * the authorization code alone is useless without it.
 *
 * PKCE degrades gracefully: if the DB is unavailable the helpers return null
 * and the OAuth flow still works (just without the extra PKCE layer). This
 * is the same fail-open semantic as the pre-Postgres implementation.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7636
 * @module @pagespace/lib/auth/pkce
 */

import crypto from 'crypto';
import { db, authHandoffTokens, sql } from '@pagespace/db';
import { loggers } from '../logging/logger-config';

const PKCE_TTL_SECONDS = 600; // 10 minutes — enough for OAuth round-trip
const PKCE_KIND = 'pkce';

function stateHashFor(stateParam: string): string {
  return crypto.createHash('sha256').update(stateParam).digest('hex');
}

/**
 * Generate PKCE code_verifier and code_challenge (S256 method).
 * Stores the verifier in Postgres keyed by the SHA-256 hash of the state
 * param (the state is the OAuth correlation key).
 *
 * Returns null on DB failure — PKCE degrades gracefully.
 */
export async function generatePKCE(stateParam: string): Promise<{
  codeChallenge: string;
  codeChallengeMethod: 'S256';
} | null> {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  const expiresAt = new Date(Date.now() + PKCE_TTL_SECONDS * 1000);

  try {
    await db
      .insert(authHandoffTokens)
      .values({
        tokenHash: stateHashFor(stateParam),
        kind: PKCE_KIND,
        payload: { verifier: codeVerifier },
        expiresAt,
      })
      .onConflictDoUpdate({
        target: [authHandoffTokens.tokenHash, authHandoffTokens.kind],
        set: {
          payload: { verifier: codeVerifier },
          expiresAt,
        },
      });
  } catch (error) {
    loggers.auth.warn('PKCE: DB unavailable, skipping code challenge generation', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  return { codeChallenge, codeChallengeMethod: 'S256' };
}

/**
 * Atomically retrieve and consume the PKCE code_verifier for a given state.
 * One-time use: a second call returns null. Expired rows return null (and
 * are not deleted by this path — the cron sweeper handles them).
 *
 * Returns null on DB failure — never throws.
 */
export async function consumePKCEVerifier(stateParam: string): Promise<string | null> {
  const tokenHash = stateHashFor(stateParam);

  try {
    const result = await db.execute<{ payload: { verifier: string } }>(
      sql`DELETE FROM ${authHandoffTokens}
          WHERE ${authHandoffTokens.tokenHash} = ${tokenHash}
            AND ${authHandoffTokens.kind} = ${PKCE_KIND}
            AND ${authHandoffTokens.expiresAt} > now()
          RETURNING ${authHandoffTokens.payload} AS payload`,
    );

    const row = result.rows[0];
    if (!row) return null;
    const verifier = row.payload?.verifier;
    return typeof verifier === 'string' ? verifier : null;
  } catch (error) {
    loggers.auth.warn('PKCE: consume failed, returning null', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

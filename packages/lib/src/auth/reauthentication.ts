/**
 * Re-authenticating the CURRENT session (D-OW-45; SEC-2/SEC-3). IO only; the rule is decideReauthentication
 * (organizations/authentication-policy-core.ts).
 *
 * An org sign-in policy refuses a credential whose evidence is too weak or too old. Rather than signing the person out,
 * the client runs a fresh ceremony through the existing step-up flow (a user-verified passkey, or an emailed link)
 * and the server stamps the evidence THAT ceremony earned onto the session that ran it. The caller passes evidence
 * only from a consumed, server-verified step-up grant — never anything the client claims.
 *
 * One transaction: the session row is locked (FOR UPDATE), the decision is made over the evidence it holds, and the
 * write lands before the lock is released, so two ceremonies cannot interleave. A device token bound to the same device is stamped too (never
 * lowered), or the next device refresh would mint a session that forgot the ceremony.
 */
import { db } from '@pagespace/db/db';
import { and, eq, gt, isNull, ne, or, sql } from '@pagespace/db/operators';
import { deviceTokens } from '@pagespace/db/schema/auth';
import { sessions } from '@pagespace/db/schema/sessions';
import { parseVerifiedAuthentication, type VerifiedAuthentication } from './authentication-evidence';
import { decideReauthentication } from '../organizations/authentication-policy-core';

export type ReauthenticateSessionResult =
  | { readonly ok: true; readonly authentication: VerifiedAuthentication }
  | { readonly ok: false; readonly reason: 'session_not_found' | 'weaker_than_current' };

export async function reauthenticateSession(input: {
  readonly sessionId: string;
  readonly userId: string;
  readonly fresh: VerifiedAuthentication;
}): Promise<ReauthenticateSessionResult> {
  const { sessionId, userId, fresh } = input;
  return db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .select({ deviceId: sessions.deviceId, authenticatedAt: sessions.authenticatedAt, authenticationAssurance: sessions.authenticationAssurance })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), eq(sessions.type, 'user'), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
      .for('update')
      .limit(1);
    if (!row) return { ok: false, reason: 'session_not_found' } as const;

    const current = parseVerifiedAuthentication({ authenticatedAtMs: row.authenticatedAt?.getTime(), assurance: row.authenticationAssurance }, now.getTime());
    const decision = decideReauthentication({ current, fresh });
    if (!decision.ok) return { ok: false, reason: decision.reason } as const;

    const authenticatedAt = new Date(decision.authentication.authenticatedAtMs);
    await tx.update(sessions)
      .set({ authenticatedAt, authenticationAssurance: decision.authentication.assurance })
      .where(eq(sessions.id, sessionId));

    if (row.deviceId) {
      await tx.update(deviceTokens)
        .set({ authenticatedAt, authenticationAssurance: decision.authentication.assurance })
        .where(and(
          eq(deviceTokens.userId, userId),
          eq(deviceTokens.deviceId, row.deviceId),
          isNull(deviceTokens.revokedAt),
          gt(deviceTokens.expiresAt, now),
          // never lower a device token that holds a passkey ceremony
          decision.authentication.assurance === 'user_verified_passkey'
            ? sql`true`
            : or(isNull(deviceTokens.authenticationAssurance), ne(deviceTokens.authenticationAssurance, 'user_verified_passkey')),
        ));
    }
    return { ok: true, authentication: decision.authentication } as const;
  });
}

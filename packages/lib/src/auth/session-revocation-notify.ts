import { createSignedBroadcastHeaders } from './broadcast-auth';
import { loggers } from '../logging/logger-config';

/**
 * Notify the realtime service that EVERY session for `userId` was just
 * revoked (admin force-logout, admin suspension) so it can forcibly
 * disconnect that user's live Socket.IO sockets. Revoking sessions in the DB
 * alone leaves an already-open socket authenticated until it happens to
 * reconnect — a suspended or force-logged-out user must not be able to keep
 * using an existing connection.
 *
 * Best-effort: a failure here must never fail the caller's session
 * revocation, so every error is caught and logged, never thrown.
 */
export async function notifyUserSessionsRevoked(userId: string, reason: string): Promise<void> {
  const realtimeUrl = process.env.INTERNAL_REALTIME_URL;
  if (!realtimeUrl) return;

  try {
    const requestBody = JSON.stringify({
      userId,
      roomPattern: '*',
      reason: 'session_revoked',
      disconnect: true,
      metadata: { revocationReason: reason },
    });

    await fetch(`${realtimeUrl}/api/kick`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    loggers.auth.error('Failed to notify realtime of session revocation', error as Error, { userId });
  }
}

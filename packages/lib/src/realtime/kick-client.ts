/**
 * Kick client — the web→realtime revocation-kick transport (#2158).
 *
 * POSTs a signed kick request to the realtime server's /api/kick endpoint
 * (handled by apps/realtime/src/kick-handler.ts), which removes the user's
 * sockets from the matching rooms and emits `access_revoked` so clients can
 * react gracefully.
 *
 * Lives in @pagespace/lib (moved from apps/web's socket-utils) so the
 * permission mutation layer (../permissions/revocation-kick.ts) can trigger
 * kicks directly — instead of every web route having to remember to.
 *
 * Best-effort BY DESIGN: room membership is a delivery optimization over the
 * authoritative per-event permission recheck (see ./rooms.ts, TRUST MODEL).
 * Every failure mode — no realtime URL, HTTP rejection, network error —
 * resolves to `{ success: false }`; this function never throws, and callers
 * must never let a kick failure fail the revocation that triggered it.
 */

import { createSignedBroadcastHeaders } from '../auth/broadcast-auth';
import { loggers } from '../logging/logger-config';

/** Every valid kick reason — the single source both the web caller and the realtime handler's payload validation derive from. */
export const KICK_REASONS = [
  'member_removed',
  'role_changed',
  'permission_revoked',
  'session_revoked',
  'page_private',
] as const;

export type KickReason = (typeof KICK_REASONS)[number];

export interface KickPayload {
  userId: string;
  /** An exact room name from ./rooms.ts builders. */
  roomPattern: string;
  reason: KickReason;
  metadata?: {
    driveId?: string;
    pageId?: string;
    driveName?: string;
  };
}

export interface KickResult {
  success: boolean;
  kickedCount: number;
  rooms: string[];
  error?: string;
}

/** Client-received shape of the `access_revoked` socket event (emitted by apps/realtime/src/kick-handler.ts's executeKick). */
export interface AccessRevokedPayload {
  room: string;
  reason: KickReason;
  metadata?: {
    driveId?: string;
    pageId?: string;
    driveName?: string;
  };
}

/**
 * Kicks a user from Socket.IO rooms on permission revocation.
 */
export async function kickUserFromRooms(payload: KickPayload): Promise<KickResult> {
  const realtimeUrl = process.env.INTERNAL_REALTIME_URL;
  if (!realtimeUrl) {
    loggers.realtime.warn('Realtime URL not configured, skipping kick', {
      roomPattern: payload.roomPattern,
      reason: payload.reason,
    });
    return { success: false, kickedCount: 0, rooms: [], error: 'Realtime URL not configured' };
  }

  try {
    const requestBody = JSON.stringify(payload);

    const response = await fetch(`${realtimeUrl}/api/kick`, {
      method: 'POST',
      headers: createSignedBroadcastHeaders(requestBody),
      body: requestBody,
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      loggers.realtime.error('Kick request rejected by realtime server', undefined, {
        roomPattern: payload.roomPattern,
        reason: payload.reason,
        status: response.status,
        errorBody,
      });
      return { success: false, kickedCount: 0, rooms: [], error: `Kick request failed with status ${response.status}` };
    }

    const result = await response.json() as KickResult;

    if (result.success) {
      loggers.realtime.info('User kicked from rooms', {
        roomPattern: payload.roomPattern,
        reason: payload.reason,
        kickedCount: result.kickedCount,
      });
    }

    return result;
  } catch (error) {
    loggers.realtime.error(
      'Failed to kick user from rooms',
      error instanceof Error ? error : undefined,
      { roomPattern: payload.roomPattern, reason: payload.reason },
    );
    return { success: false, kickedCount: 0, rooms: [], error: 'Network error' };
  }
}

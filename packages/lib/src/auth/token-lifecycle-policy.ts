/**
 * Pure token-lifecycle policy decisions for the session/device token area.
 *
 * These functions contain NO I/O — they are the isolated decision points behind
 * three auth routes so the rules can be unit-tested in isolation and the route
 * shells stay thin:
 *
 *  - {@link shouldAllowDeviceRefresh} — device/refresh rebind guard (closes L4:
 *    a legacy `'unknown'` stored deviceId must force full re-auth, never silently
 *    rebind to an attacker-supplied id).
 *  - {@link getWsTokenPolicy} — the issued ws-token's {type, scopes, ttl} (closes
 *    L5: a narrow, user-scoped, short-lived token dedicated to desktop websocket
 *    auth instead of a 90-day `type:'service'` `mcp:*` token the processor's
 *    service middleware would also accept).
 *  - {@link planLogoutDeviceRevocation} — which device-token revocation a logout
 *    should perform (closes M9: logout must revoke the 90-day device token, not
 *    just the session).
 */

export type DevicePlatform = 'web' | 'desktop' | 'ios' | 'android';

const DEVICE_PLATFORMS: readonly DevicePlatform[] = ['web', 'desktop', 'ios', 'android'];

export function isDevicePlatform(value: unknown): value is DevicePlatform {
  return typeof value === 'string' && (DEVICE_PLATFORMS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// L4 — device/refresh rebind guard
// ---------------------------------------------------------------------------

/** Minimal shape of a device-token record needed to decide a refresh. */
export interface DeviceRefreshRecord {
  deviceId: string | null | undefined;
}

export type DeviceRefreshDenialReason =
  | 'unknown_stored_device'
  | 'missing_supplied_device'
  | 'device_mismatch';

export type DeviceRefreshDecision =
  | { ok: true }
  | { ok: false; reason: DeviceRefreshDenialReason };

/**
 * Decide whether a device-token refresh may proceed for the supplied device id.
 *
 * SECURITY (L4): a stored deviceId that is missing or the legacy sentinel
 * `'unknown'` is a HARD failure — the caller must perform a full re-auth. We do
 * NOT auto-rebind the record to whatever deviceId the request supplies, because
 * that would let a stolen-but-legacy token be re-bound to the attacker's device
 * and bypass the device-binding check entirely.
 */
export function shouldAllowDeviceRefresh(
  record: DeviceRefreshRecord,
  suppliedDeviceId: string | null | undefined,
): DeviceRefreshDecision {
  const stored = record.deviceId;

  // Missing or legacy 'unknown' stored deviceId → force full re-auth.
  if (!stored || stored === 'unknown') {
    return { ok: false, reason: 'unknown_stored_device' };
  }

  if (!suppliedDeviceId) {
    return { ok: false, reason: 'missing_supplied_device' };
  }

  if (stored !== suppliedDeviceId) {
    return { ok: false, reason: 'device_mismatch' };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// L5 — ws-token policy
// ---------------------------------------------------------------------------

/**
 * TTL for desktop websocket tokens. Substantially shorter than the previous
 * 90-day lifetime: the desktop client re-fetches a ws-token automatically on
 * (re)connect, so a short-lived token costs nothing operationally while sharply
 * limiting the blast radius of a leaked token.
 */
export const WS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Narrow scope dedicated to desktop websocket auth (not the `mcp:*` wildcard). */
export const WS_TOKEN_SCOPE = 'mcp:ws';

export interface WsTokenPolicy {
  /** User-scoped session type, NOT `'service'` — the processor's service
   * middleware requires `type === 'service'`, so this token can no longer be
   * replayed against service-to-service endpoints. */
  type: 'mcp';
  scopes: [typeof WS_TOKEN_SCOPE];
  ttlMs: number;
}

/**
 * The policy for a desktop websocket token (L5).
 *
 * Returns a narrow, user-scoped, short-lived token dedicated to websocket auth
 * instead of reusing a long-lived `type:'service'` `mcp:*` token.
 */
export function getWsTokenPolicy(): WsTokenPolicy {
  return {
    type: 'mcp',
    scopes: [WS_TOKEN_SCOPE],
    ttlMs: WS_TOKEN_TTL_MS,
  };
}

// ---------------------------------------------------------------------------
// M9 — logout device-token revocation plan
// ---------------------------------------------------------------------------

export interface LogoutRevocationInput {
  /** Raw device token value, if the client sends it on logout. */
  deviceToken?: string | null;
  /** Authenticated user id from the session. */
  userId?: string | null;
  /** Device fingerprint the client claims to be logging out. */
  deviceId?: string | null;
  /** Device platform the client claims to be logging out. */
  platform?: unknown;
}

export type LogoutRevocationPlan =
  | { strategy: 'by-value'; deviceToken: string }
  | { strategy: 'by-device'; userId: string; deviceId: string; platform: DevicePlatform }
  | { strategy: 'none' };

/**
 * Decide how a logout should revoke the caller's device token(s) (M9).
 *
 * Preference order:
 *  1. If the client sends the raw device token value, revoke exactly that token.
 *  2. Otherwise, if we have the authenticated userId plus a deviceId and a valid
 *     platform, revoke that user's device token(s) for that device.
 *  3. Otherwise there is nothing safe to target (e.g. a plain web logout with no
 *     device context) — revoke nothing beyond the session.
 */
export function planLogoutDeviceRevocation(input: LogoutRevocationInput): LogoutRevocationPlan {
  const deviceToken = typeof input.deviceToken === 'string' ? input.deviceToken.trim() : '';
  if (deviceToken.length > 0) {
    return { strategy: 'by-value', deviceToken };
  }

  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  const deviceId = typeof input.deviceId === 'string' ? input.deviceId.trim() : '';
  if (userId.length > 0 && deviceId.length > 0 && isDevicePlatform(input.platform)) {
    return { strategy: 'by-device', userId, deviceId, platform: input.platform };
  }

  return { strategy: 'none' };
}

/**
 * Sign in with Apple server-to-server notifications (TN3194 "Respond to
 * credential revoked notifications").
 *
 * Apple POSTs `{ "payload": "<JWT>" }` to the endpoint registered for the
 * primary App ID. The JWT is RS256-signed with Apple's key (JWKS at
 * https://appleid.apple.com/auth/keys), `iss` is Apple, `aud` is our client, and
 * `events` names the user (`sub`, the same value we store as users.appleId).
 *
 * When the user stops using Sign in with Apple for PageSpace (`consent-revoked`)
 * or deletes their Apple Account (`account-delete[d]`), every PageSpace session
 * for that user ends and the stored Apple token is discarded. The PageSpace
 * account itself is kept (founder decision): the user may still reach it
 * another way, and deleting it is their call.
 */
import { verifyAppleJwt } from './apple-jwt';
import type { AppleKeyProvider } from './apple-jwks';
import { db } from '@pagespace/db/db';
import { eq, sql } from '@pagespace/db/operators';
import { users } from '@pagespace/db/schema/auth';
import { loggers } from '../../logging/logger-config';
import { sessionService } from '../session-service';
import { revokeAllUserDeviceTokens } from '../device-auth-utils';
import { appleTokenStore } from './apple-token-store';

export interface AppleNotificationEvent {
  type: string;
  sub: string;
  /** When the change happened, in ms. Absent when Apple omits `event_time`. */
  eventTimeMs?: number;
}

/** Apple's docs show `event_time` in seconds; real payloads carry milliseconds. */
const toMilliseconds = (value: number): number => (value < 1e12 ? value * 1000 : value);

export type AppleNotificationVerification =
  | { ok: true; event: AppleNotificationEvent }
  | { ok: false; reason: string };

/** Deliberately loose: `process.env` is passed straight in. */
type AppleClientEnv = Readonly<Record<string, string | undefined>>;

/** Apple's docs say `account-deleted`; some payloads (and older docs) say `account-delete`. Honour both. */
const SESSION_ENDING_EVENTS = new Set(['consent-revoked', 'account-delete', 'account-deleted']);

function parseEvents(events: unknown): AppleNotificationEvent | null {
  let value = events;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;
  const { type, sub, event_time: eventTime } = value as { type?: unknown; sub?: unknown; event_time?: unknown };
  if (typeof type !== 'string' || typeof sub !== 'string' || sub.length === 0) return null;
  return typeof eventTime === 'number' && Number.isFinite(eventTime)
    ? { type, sub, eventTimeMs: toMilliseconds(eventTime) }
    : { type, sub };
}

/** Verify signature (Apple JWKS), issuer, audience and expiry, then extract the event. */
export async function verifyAppleServerNotification(
  payload: string,
  env: AppleClientEnv = process.env,
  keys?: AppleKeyProvider,
): Promise<AppleNotificationVerification> {
  const audience = [env.APPLE_CLIENT_ID, env.APPLE_SERVICE_ID].filter((id): id is string => Boolean(id));
  if (audience.length === 0) return { ok: false, reason: 'apple_not_configured' };

  // RS256 against the shared PageSpace-owned JWKS cache, Apple issuer, our
  // audience, and a required `exp` (a notification without one would never
  // expire). This endpoint is unauthenticated, so key lookups for unknown kids
  // are throttled by the cache rather than fetched per request.
  const verification = await verifyAppleJwt(payload, { audience, keys });
  if (!verification.ok) return verification;

  const event = parseEvents(verification.claims.events);
  return event ? { ok: true, event } : { ok: false, reason: 'invalid_events' };
}

export interface AppleNotificationDeps {
  findUserIdByAppleId: (appleId: string) => Promise<string | null>;
  discardAppleTokens: (userId: string) => Promise<unknown>;
  endAllSessions: (userId: string) => Promise<unknown>;
  /** When the user's newest Apple refresh token was captured, if any. */
  latestAppleTokenCaptureAt: (userId: string) => Promise<Date | null>;
}

export type AppleNotificationAction =
  | { action: 'sessions_ended'; userId: string }
  | { action: 'stale_event'; userId: string }
  | { action: 'unknown_user' }
  | { action: 'ignored' };

const defaultDeps: AppleNotificationDeps = {
  async findUserIdByAppleId(appleId) {
    const row = await db.query.users.findFirst({ where: eq(users.appleId, appleId), columns: { id: true } });
    return row?.id ?? null;
  },
  discardAppleTokens: (userId) => appleTokenStore.deleteForUser(userId),
  latestAppleTokenCaptureAt: (userId) => appleTokenStore.latestCaptureAt(userId),
  async endAllSessions(userId) {
    // Same three levers as a full sign-out: live sessions, device tokens (which
    // would otherwise mint new sessions), and tokenVersion for anything derived.
    await sessionService.revokeAllUserSessions(userId, 'apple_consent_revoked');
    await revokeAllUserDeviceTokens(userId, 'token_version_change');
    await db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, userId));
  },
};

export async function handleAppleServerNotification(
  event: AppleNotificationEvent,
  deps: AppleNotificationDeps = defaultDeps,
): Promise<AppleNotificationAction> {
  if (!SESSION_ENDING_EVENTS.has(event.type)) {
    // email-enabled / email-disabled: relay forwarding changes; nothing to act on.
    return { action: 'ignored' };
  }

  const userId = await deps.findUserIdByAppleId(event.sub);
  if (!userId) return { action: 'unknown_user' };

  // Apple is known to resend old notifications. A revocation from before the
  // user's latest Sign in with Apple (which re-granted consent) is stale and
  // must not log them out again.
  if (event.eventTimeMs !== undefined) {
    const latestCapture = await deps.latestAppleTokenCaptureAt(userId);
    if (latestCapture && event.eventTimeMs < latestCapture.getTime()) {
      loggers.auth.info('Ignored stale Apple consent notification', { userId, eventType: event.type });
      return { action: 'stale_event', userId };
    }
  }

  await deps.discardAppleTokens(userId);
  await deps.endAllSessions(userId);
  loggers.auth.info('Apple consent revoked: sessions ended and Apple tokens discarded', { userId, eventType: event.type });
  return { action: 'sessions_ended', userId };
}

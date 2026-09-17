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
import appleSignIn from 'apple-signin-auth';
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
}

export type AppleNotificationVerification =
  | { ok: true; event: AppleNotificationEvent }
  | { ok: false; reason: string };

interface AppleClientEnv {
  APPLE_CLIENT_ID?: string;
  APPLE_SERVICE_ID?: string;
}

/** Apple's docs say `account-deleted`; apple-signin-auth's types say `account-delete`. Honour both. */
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
  const { type, sub } = value as { type?: unknown; sub?: unknown };
  if (typeof type !== 'string' || typeof sub !== 'string' || sub.length === 0) return null;
  return { type, sub };
}

/** Verify signature (Apple JWKS), issuer, audience and expiry, then extract the event. */
export async function verifyAppleServerNotification(
  payload: string,
  env: AppleClientEnv = process.env,
): Promise<AppleNotificationVerification> {
  const audience = [env.APPLE_CLIENT_ID, env.APPLE_SERVICE_ID].filter((id): id is string => Boolean(id));
  if (audience.length === 0) return { ok: false, reason: 'apple_not_configured' };

  let claims: { events?: unknown };
  try {
    // verifyIdToken is the library's plain RS256 + Apple-issuer JWT check; unlike
    // verifyWebhookToken it does not assume `events` is a JSON string.
    claims = (await appleSignIn.verifyIdToken(payload, {
      audience,
      algorithms: ['RS256'],
      ignoreExpiration: false,
    })) as unknown as { events?: unknown };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.name : 'verification_failed' };
  }

  const event = parseEvents(claims.events);
  return event ? { ok: true, event } : { ok: false, reason: 'invalid_events' };
}

export interface AppleNotificationDeps {
  findUserIdByAppleId: (appleId: string) => Promise<string | null>;
  discardAppleTokens: (userId: string) => Promise<unknown>;
  endAllSessions: (userId: string) => Promise<unknown>;
}

export type AppleNotificationAction =
  | { action: 'sessions_ended'; userId: string }
  | { action: 'unknown_user' }
  | { action: 'ignored' };

const defaultDeps: AppleNotificationDeps = {
  async findUserIdByAppleId(appleId) {
    const row = await db.query.users.findFirst({ where: eq(users.appleId, appleId), columns: { id: true } });
    return row?.id ?? null;
  },
  discardAppleTokens: (userId) => appleTokenStore.deleteForUser(userId),
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

  await deps.discardAppleTokens(userId);
  await deps.endAllSessions(userId);
  loggers.auth.info('Apple consent revoked: sessions ended and Apple tokens discarded', { userId, eventType: event.type });
  return { action: 'sessions_ended', userId };
}

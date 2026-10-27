import { sessionService } from '@pagespace/lib/auth/session-service';
import {
  revokeDeviceTokenByValue,
  revokeDeviceTokensByDevice,
} from '@pagespace/lib/auth/device-auth-utils';
import { planLogoutDeviceRevocation } from '@pagespace/lib/auth/token-lifecycle-policy';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { trackAuthEvent } from '@pagespace/lib/monitoring/activity-tracker';
import { getClientIP } from '@/lib/auth';
import { getSessionFromCookies, appendClearCookies } from '@/lib/auth/cookie-config';

export async function POST(req: Request) {
  const clientIP = getClientIP(req);
  const cookieHeader = req.headers.get('cookie');
  const sessionToken = getSessionFromCookies(cookieHeader);

  // Parse device context up front. SECURITY (M9): we must be able to revoke a
  // long-lived device token *by value* even when the session cookie is already
  // missing or expired — that is exactly when the still-valid device token is
  // the only credential left and must be invalidated. So this runs before any
  // no-session short-circuit. Web logout may send no body.
  const body = await req.json().catch(() => ({}));
  const { deviceToken, deviceId, platform } = (body ?? {}) as {
    deviceToken?: unknown;
    deviceId?: unknown;
    platform?: unknown;
  };

  // Validate + revoke the session when one is present.
  let userId: string | undefined;
  let sessionId: string | undefined;
  let sessionRevokeSucceeded = false;
  if (sessionToken) {
    // Only a real browser session may trigger logout's userId-scoped device
    // revocation — a leaked non-user token in the session cookie must not be
    // able to revoke another user's device tokens.
    const sessionClaims = await sessionService.validateSession(sessionToken, { expectedType: 'user' });
    userId = sessionClaims?.userId;
    sessionId = sessionClaims?.sessionId;
    try {
      await sessionService.revokeSession(sessionToken, 'logout');
      sessionRevokeSucceeded = true;
      loggers.auth.debug('Session revoked on logout', { userId });
    } catch (error) {
      loggers.auth.error('Failed to revoke session on logout', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });
    }
  }

  // SECURITY (M9): logout must also revoke the caller's 90-day device token,
  // otherwise device/refresh can silently re-mint sessions after "logout".
  // By-value revocation needs no authenticated session; by-device requires the
  // session-derived userId (so it only fires for the caller's own device).
  // A failure here must never break logout itself.
  const revocationPlan = planLogoutDeviceRevocation({ deviceToken, userId, deviceId, platform });

  if (revocationPlan.strategy !== 'none') {
    try {
      let deviceTokensRevoked = false;
      if (revocationPlan.strategy === 'by-value') {
        deviceTokensRevoked = await revokeDeviceTokenByValue(revocationPlan.deviceToken, 'logout');
      } else {
        const count = await revokeDeviceTokensByDevice(
          revocationPlan.userId,
          revocationPlan.deviceId,
          revocationPlan.platform,
          'logout',
        );
        deviceTokensRevoked = count > 0;
      }

      if (deviceTokensRevoked) {
        if (userId) {
          auditRequest(req, {
            eventType: 'auth.token.revoked',
            userId,
            details: { tokenType: 'device', reason: 'user_logout' },
          });
        } else {
          // By-value revocation without an active session (expired-session
          // logout). No userId for an audit row, but record a trail.
          loggers.auth.info('Device token revoked on logout without active session', {
            strategy: revocationPlan.strategy,
          });
        }
      }
    } catch (error) {
      loggers.auth.error('Failed to revoke device token on logout', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        strategy: revocationPlan.strategy,
      });
    }
  }

  // Only emit session audit/track events after a successful session revoke
  if (userId && sessionRevokeSucceeded) {
    auditRequest(req, {
      eventType: 'auth.logout',
      userId,
      sessionId: sessionId ?? 'unknown',
    });
    auditRequest(req, {
      eventType: 'auth.token.revoked',
      userId,
      details: { tokenType: 'session', reason: 'user_logout' },
    });
    trackAuthEvent(userId, 'logout', {
      ip: clientIP,
      userAgent: req.headers.get('user-agent')
    });
  }

  const headers = new Headers();
  appendClearCookies(headers);

  return Response.json({ message: 'Logged out successfully' }, { status: 200, headers });
}

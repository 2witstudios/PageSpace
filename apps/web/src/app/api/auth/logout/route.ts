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

  if (!sessionToken) {
    // No session to logout from
    const headers = new Headers();
    appendClearCookies(headers);
    return Response.json({ message: 'Logged out successfully' }, { status: 200, headers });
  }

  // Validate session to get user ID for logging
  const sessionClaims = await sessionService.validateSession(sessionToken);
  const userId = sessionClaims?.userId;

  // The client may include device context so we can revoke the long-lived
  // device token alongside the session (M9). Web logout sends no body.
  const body = await req.json().catch(() => ({}));
  const { deviceToken, deviceId, platform } = (body ?? {}) as {
    deviceToken?: unknown;
    deviceId?: unknown;
    platform?: unknown;
  };

  // Revoke the session
  let revokeSucceeded = false;
  try {
    await sessionService.revokeSession(sessionToken, 'logout');
    revokeSucceeded = true;
    loggers.auth.debug('Session revoked on logout', { userId });
  } catch (error) {
    loggers.auth.error('Failed to revoke session on logout', {
      error: error instanceof Error ? error.message : String(error),
      userId,
    });
  }

  // SECURITY (M9): logout must also revoke the caller's 90-day device token,
  // otherwise device/refresh can silently re-mint sessions after "logout".
  // A failure here must never break logout itself.
  const revocationPlan = planLogoutDeviceRevocation({
    deviceToken: typeof deviceToken === 'string' ? deviceToken : null,
    userId,
    deviceId: typeof deviceId === 'string' ? deviceId : null,
    platform,
  });

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

      if (deviceTokensRevoked && userId) {
        auditRequest(req, {
          eventType: 'auth.token.revoked',
          userId,
          details: { tokenType: 'device', reason: 'user_logout' },
        });
      }
    } catch (error) {
      loggers.auth.error('Failed to revoke device token on logout', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        strategy: revocationPlan.strategy,
      });
    }
  }

  // Only emit audit/track events after a successful revoke
  if (userId && revokeSucceeded) {
    auditRequest(req, {
      eventType: 'auth.logout',
      userId,
      sessionId: sessionClaims?.sessionId ?? 'unknown',
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

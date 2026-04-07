/**
 * Desktop Session Helper
 *
 * Shared utility for creating authenticated desktop sessions with
 * session token, CSRF token, and device token. Used by all auth
 * routes that need desktop-specific token handling.
 *
 * @module @pagespace/lib/auth/desktop-session
 */

import { sessionService } from './session-service';
import { SESSION_DURATION_MS } from './constants';
import { generateCSRFToken } from './csrf-utils';
import { validateOrCreateDeviceToken } from './device-auth-utils';
import { loggers } from '../logging/logger-config';

export interface CreateDesktopSessionParams {
  userId: string;
  deviceId: string;
  deviceName: string;
  provider: string;
  clientIP: string;
  userAgent?: string;
  tokenVersion: number;
}

export interface DesktopSessionResult {
  sessionToken: string;
  csrfToken: string;
  deviceToken: string;
}

export async function createDesktopSession(
  params: CreateDesktopSessionParams
): Promise<DesktopSessionResult> {
  const { userId, deviceId, deviceName, provider, clientIP, userAgent, tokenVersion } = params;

  const revokedCount = await sessionService.revokeAllUserSessions(
    userId,
    `desktop_${provider}_login`
  );
  if (revokedCount > 0) {
    loggers.auth.info('Revoked existing sessions on desktop login', {
      userId,
      provider,
      count: revokedCount,
    });
  }

  const sessionToken = await sessionService.createSession({
    userId,
    type: 'user',
    scopes: ['*'],
    expiresInMs: SESSION_DURATION_MS,
    createdByIp: clientIP !== 'unknown' ? clientIP : undefined,
  });

  // Validate session to get claims for CSRF generation
  const sessionClaims = await sessionService.validateSession(sessionToken);
  if (!sessionClaims) {
    loggers.auth.error('Failed to validate newly created desktop session', { userId, provider });
    throw new Error('Failed to validate newly created desktop session');
  }

  const csrfToken = generateCSRFToken(sessionClaims.sessionId);

  const { deviceToken } = await validateOrCreateDeviceToken({
    providedDeviceToken: undefined,
    userId,
    deviceId,
    platform: 'desktop',
    tokenVersion,
    deviceName,
    userAgent,
    ipAddress: clientIP !== 'unknown' ? clientIP : undefined,
  });

  loggers.auth.info('Desktop session created', { userId, provider });

  return { sessionToken, csrfToken, deviceToken };
}

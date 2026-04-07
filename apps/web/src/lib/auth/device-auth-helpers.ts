import { sessionService } from '@pagespace/lib/auth';
import { validateOrCreateDeviceToken, loggers } from '@pagespace/lib/server';

/**
 * Revoke existing sessions before login, scoped to a specific device when possible.
 * Falls back to revoking all sessions for backward compatibility with older clients.
 */
export async function revokeSessionsForLogin(
  userId: string,
  deviceId: string | undefined,
  reason: string,
  provider = 'password',
): Promise<number> {
  if (!deviceId) return 0;
  const count = await sessionService.revokeDeviceSessions(userId, deviceId, reason);
  if (count > 0) loggers.auth.info(`Revoked device sessions on ${provider} login`, { userId, deviceId, count });
  return count;
}

/**
 * Create or reuse a web device token for session persistence.
 * Enables recovery when the session cookie expires (7 days).
 */
export async function createWebDeviceToken(params: {
  userId: string;
  deviceId: string;
  tokenVersion: number;
  providedDeviceToken?: string | null;
  deviceName?: string;
  userAgent?: string;
  ipAddress?: string;
}): Promise<string> {
  const result = await validateOrCreateDeviceToken({
    providedDeviceToken: params.providedDeviceToken ?? null,
    userId: params.userId,
    deviceId: params.deviceId,
    platform: 'web',
    tokenVersion: params.tokenVersion,
    deviceName: params.deviceName || 'Web Browser',
    userAgent: params.userAgent,
    ipAddress: params.ipAddress,
  });
  return result.deviceToken;
}

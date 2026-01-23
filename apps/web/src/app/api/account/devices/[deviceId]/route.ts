import { db, eq, deviceTokens, refreshTokens } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { secureCompare } from '@pagespace/lib/secure-compare';
import { hashToken } from '@pagespace/lib/auth';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { revokeDeviceToken } from '@pagespace/lib/device-auth-utils';
import { getActorInfo, logTokenActivity } from '@pagespace/lib/monitoring/activity-logger';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

export async function DELETE(
  req: Request,
  context: { params: Promise<{ deviceId: string }> }
) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) {
    return auth.error;
  }
  const userId = auth.userId;
  const { deviceId } = await context.params;

  try {
    // Get the device token to revoke
    const device = await db.query.deviceTokens.findFirst({
      where: eq(deviceTokens.id, deviceId),
    });

    if (!device) {
      return Response.json({ error: 'Device not found' }, { status: 404 });
    }

    // Verify the device belongs to the user
    if (device.userId !== userId) {
      return Response.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // Check if this is the current device
    // SECURITY: Hash the incoming token to compare with stored hash (tokens are stored hashed)
    const currentDeviceToken = req.headers.get('x-device-token');
    const currentDeviceTokenHash = currentDeviceToken ? hashToken(currentDeviceToken) : null;
    const isCurrentDevice = currentDeviceTokenHash && device.tokenHash
      ? secureCompare(device.tokenHash, currentDeviceTokenHash)
      : false;

    // Revoke the device token
    await revokeDeviceToken(deviceId, 'user_action');

    // SECURITY: Delete all refresh tokens associated with this device
    // This prevents revoked devices from continuing to access the account via refresh tokens
    const deletedTokens = await db.delete(refreshTokens)
      .where(eq(refreshTokens.deviceTokenId, deviceId))
      .returning({ id: refreshTokens.id });

    loggers.auth.info(`User ${userId} revoked device ${deviceId}`, {
      platform: device.platform,
      deviceName: device.deviceName,
      isCurrentDevice,
      refreshTokensDeleted: deletedTokens.length,
    });

    // Log activity for audit trail (device revocation is a security event)
    const actorInfo = await getActorInfo(userId);
    logTokenActivity(userId, 'token_revoke', {
      tokenId: deviceId,
      tokenType: 'device',
      tokenName: device.deviceName ?? undefined,
      deviceInfo: `${device.platform ?? 'Unknown'} - ${device.deviceName ?? 'Unknown'}`,
    }, actorInfo);

    return Response.json({
      message: 'Device revoked successfully',
      requiresLogout: isCurrentDevice,
    });
  } catch (error) {
    loggers.auth.error('Failed to revoke device:', error as Error);
    return Response.json({ error: 'Failed to revoke device' }, { status: 500 });
  }
}

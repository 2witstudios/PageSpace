import { users, db, eq, deviceTokens } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { revokeDeviceToken } from '@pagespace/lib/device-auth-utils';
import bcrypt from 'bcryptjs';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

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
    const body = await req.json();
    const { password } = body;

    // Validate password is provided
    if (!password) {
      return Response.json({ error: 'Password is required' }, { status: 400 });
    }

    // Get user to verify password
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        password: true,
      },
    });

    if (!user) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    if (!user.password) {
      return Response.json({ error: 'No password set for this account' }, { status: 400 });
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return Response.json({ error: 'Invalid password' }, { status: 401 });
    }

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
    const currentDeviceToken = req.headers.get('x-device-token');
    const isCurrentDevice = device.token === currentDeviceToken;

    // Revoke the device token
    await revokeDeviceToken(deviceId, 'user_action');

    loggers.auth.info(`User ${userId} revoked device ${deviceId}`, {
      platform: device.platform,
      deviceName: device.deviceName,
      isCurrentDevice,
    });

    return Response.json({
      message: 'Device revoked successfully',
      requiresLogout: isCurrentDevice,
    });
  } catch (error) {
    loggers.auth.error('Failed to revoke device:', error as Error);
    return Response.json({ error: 'Failed to revoke device' }, { status: 500 });
  }
}

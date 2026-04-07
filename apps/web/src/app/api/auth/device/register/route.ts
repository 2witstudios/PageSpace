import { z } from 'zod/v4';
import { authenticateRequestWithOptions, isAuthError, getClientIP, createWebDeviceToken } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import {
  checkDistributedRateLimit,
  resetDistributedRateLimit,
  DISTRIBUTED_RATE_LIMITS,
} from '@pagespace/lib/security';
import { authRepository } from '@/lib/repositories/auth-repository';

const registerDeviceSchema = z.object({
  deviceId: z.string().min(1, 'Device ID is required').max(128),
  deviceName: z.string().optional(),
});

/**
 * POST /api/auth/device/register
 *
 * Creates a device token for the current authenticated session.
 * Used by login flows that can't return device tokens inline (magic link, passkey).
 * The client calls this after detecting a successful login without a device token.
 */
export async function POST(req: Request) {
  const auth = await authenticateRequestWithOptions(req, { allow: ['session'] as const, requireCSRF: true });
  if (isAuthError(auth)) return auth.error;

  const clientIP = getClientIP(req);

  const rateLimitResult = await checkDistributedRateLimit(
    `device:register:ip:${clientIP}`,
    DISTRIBUTED_RATE_LIMITS.REFRESH,
  );
  if (!rateLimitResult.allowed) {
    return Response.json(
      { error: 'Too many requests', retryAfter: rateLimitResult.retryAfter },
      { status: 429, headers: { 'Retry-After': String(rateLimitResult.retryAfter || 300) } },
    );
  }

  try {
    const body = await req.json();
    const validation = registerDeviceSchema.safeParse(body);

    if (!validation.success) {
      return Response.json(
        { error: 'Invalid request', details: validation.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { deviceId, deviceName } = validation.data;

    const user = await authRepository.findUserById(auth.userId);
    if (!user) {
      return Response.json({ error: 'User not found' }, { status: 404 });
    }

    const deviceToken = await createWebDeviceToken({
      userId: auth.userId,
      deviceId,
      tokenVersion: user.tokenVersion,
      deviceName: deviceName || req.headers.get('user-agent') || 'Web Browser',
      userAgent: req.headers.get('user-agent') || undefined,
      ipAddress: clientIP !== 'unknown' ? clientIP : undefined,
    });

    await resetDistributedRateLimit(`device:register:ip:${clientIP}`).catch(() => {});

    loggers.auth.info('Device token registered via lazy registration', {
      userId: auth.userId,
      deviceId,
    });

    return Response.json({ deviceToken });
  } catch (error) {
    loggers.auth.error('Device registration error', error as Error);
    return Response.json({ error: 'Failed to register device' }, { status: 500 });
  }
}

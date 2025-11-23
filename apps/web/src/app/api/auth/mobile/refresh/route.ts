import { users, refreshTokens } from '@pagespace/db';
import { db, eq, sql } from '@pagespace/db';
import {
  decodeToken,
  generateAccessToken,
  generateRefreshToken,
  getRefreshTokenMaxAge,
  checkRateLimit,
  RATE_LIMIT_CONFIGS,
  validateOrCreateDeviceToken,
} from '@pagespace/lib/server';
import { generateCSRFToken, getSessionIdFromJWT } from '@pagespace/lib/server';
import { z } from 'zod/v4';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/server';

const refreshSchema = z.object({
  refreshToken: z.string().min(1, { message: 'Refresh token is required.' }),
  deviceId: z.string().min(1, { message: 'Device identifier is required' }),
  platform: z.enum(['ios', 'android', 'desktop']).default('ios'),
  deviceToken: z.string().optional(),
});

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const validation = refreshSchema.safeParse(body);

    if (!validation.success) {
      return Response.json({ errors: validation.error.flatten().fieldErrors }, { status: 400 });
    }

    const { refreshToken: refreshTokenValue, deviceId, platform, deviceToken: providedDeviceToken } = validation.data;

    // Rate limiting by IP address for refresh attempts
    const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0] ||
                     req.headers.get('x-real-ip') ||
                     'unknown';

    const rateLimit = checkRateLimit(`refresh:mobile:${clientIP}`, RATE_LIMIT_CONFIGS.REFRESH);

    if (!rateLimit.allowed) {
      return Response.json(
        {
          error: 'Too many refresh attempts. Please try again later.',
          retryAfter: rateLimit.retryAfter
        },
        {
          status: 429,
          headers: {
            'Retry-After': rateLimit.retryAfter?.toString() || '300'
          }
        }
      );
    }

    // Use database transaction with row-level locking to prevent race conditions
    const result = await db.transaction(async (trx) => {
      // Use SELECT FOR UPDATE to lock the row and prevent concurrent transactions
      // from reading the same token (prevents false positive reuse detection)
      const rows = await trx.execute<{
        id: string;
        token: string;
        user_id: string;
        device: string | null;
        ip: string | null;
        user_agent: string | null;
        expires_at: Date | null;
        last_used_at: Date | null;
        platform: 'ios' | 'android' | 'desktop' | null;
        device_token_id: string | null;
        created_at: Date;
      }>(sql`
        SELECT rt.*
        FROM refresh_tokens rt
        WHERE rt.token = ${refreshTokenValue}
        FOR UPDATE
        LIMIT 1
      `);

      const existingToken = rows.rows[0] || null;

      // Fetch user data if token exists
      let user: { id: string; tokenVersion: number; role: "user" | "admin"; email: string; name: string | null } | null = null;
      if (existingToken) {
        user = await trx.query.users.findFirst({
          where: eq(users.id, existingToken.user_id),
        }) || null;
      }

      // If token doesn't exist, it might have been stolen and used.
      // For added security, we check if the decoded token is valid and if so,
      // invalidate ONLY the affected device session (not all devices).
      if (!existingToken || !user) {
        const decoded = await decodeToken(refreshTokenValue);
        if (decoded) {
          // This is a critical security event. A refresh token that is not in the DB was used.
          // It could be a stolen, already-used token. Invalidate ONLY this device, not all sessions.

          // IMPORTANT: We don't bump tokenVersion here because that would log out ALL devices.
          // Instead, we only revoke device tokens if we can identify the specific device.
          // Since the refresh token is missing, we can't identify which device to revoke,
          // so we just log the security event and return error (the client will logout).

          loggers.auth.warn('Refresh token reuse detected - token missing from database', {
            userId: decoded.userId,
            ip: clientIP,
            platform: 'mobile',
            note: 'Not revoking other devices - only affecting this request'
          });
        }
        return { error: 'Invalid refresh token.' };
      }

      // Delete the token atomically to prevent double-use
      // The FOR UPDATE lock ensures no other transaction can read this row
      await trx.execute(sql`
        DELETE FROM refresh_tokens
        WHERE id = ${existingToken.id}
      `);

      return { existingToken: { ...existingToken, user } };
    });

    if (result.error || !result.existingToken) {
      return Response.json({ error: result.error || 'Invalid refresh token.' }, { status: 401 });
    }

    const { existingToken } = result;
    const { user } = existingToken;

    // Verify the token version to ensure it's not from an old session
    const decoded = await decodeToken(refreshTokenValue);
    if (!decoded || decoded.tokenVersion !== user.tokenVersion) {
      return Response.json({ error: 'Invalid refresh token version.' }, { status: 401 });
    }

    // Issue a new pair of tokens
    const newAccessToken = await generateAccessToken(user.id, user.tokenVersion, user.role);
    const newRefreshToken = await generateRefreshToken(user.id, user.tokenVersion, user.role);

    const refreshTokenPayload = await decodeToken(newRefreshToken);
    const refreshTokenExpiresAt = refreshTokenPayload?.exp
      ? new Date(refreshTokenPayload.exp * 1000)
      : new Date(Date.now() + getRefreshTokenMaxAge() * 1000);

    const { deviceToken: deviceTokenValue, deviceTokenRecordId } = await validateOrCreateDeviceToken({
      providedDeviceToken,
      userId: user.id,
      deviceId,
      platform,
      tokenVersion: user.tokenVersion,
      deviceName: existingToken.device || undefined,
      userAgent: req.headers.get('user-agent') || undefined,
      ipAddress: clientIP,
    });

    // Store the new refresh token
    await db.insert(refreshTokens).values({
      id: createId(),
      token: newRefreshToken,
      userId: user.id,
      device: req.headers.get('user-agent'),
      userAgent: req.headers.get('user-agent'),
      ip: clientIP,
      lastUsedAt: new Date(),
      platform,
      deviceTokenId: deviceTokenRecordId,
      expiresAt: refreshTokenExpiresAt,
    });

    // Generate new CSRF token for mobile client
    // Decode the new access token to get its actual iat claim
    const newDecoded = await decodeToken(newAccessToken);
    if (!newDecoded?.iat) {
      loggers.auth.error('Failed to decode access token for CSRF generation');
      return Response.json({ error: 'Failed to generate session' }, { status: 500 });
    }

    const sessionId = getSessionIdFromJWT({
      userId: user.id,
      tokenVersion: user.tokenVersion,
      iat: newDecoded.iat
    });
    const csrfToken = generateCSRFToken(sessionId);

    // Return tokens in JSON body for mobile clients
    return Response.json({
      token: newAccessToken,
      refreshToken: newRefreshToken,
      csrfToken: csrfToken,
      deviceToken: deviceTokenValue,
    }, { status: 200 });

  } catch (error) {
    loggers.auth.error('Mobile token refresh error', error as Error);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}

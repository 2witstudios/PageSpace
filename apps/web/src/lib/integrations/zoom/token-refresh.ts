import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { zoomConnections } from '@pagespace/db/schema/zoom';
import { encrypt, decrypt } from '@pagespace/lib/encryption/encryption-utils';
import { loggers } from '@pagespace/lib/logging/logger-config';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export type TokenRefreshResult =
  | { success: true; accessToken: string }
  | { success: false; error: string; requiresReauth: boolean };

export const isTokenExpired = (expiresAt: Date | null, bufferMs = TOKEN_REFRESH_BUFFER_MS): boolean => {
  if (!expiresAt) return false;
  return Date.now() >= expiresAt.getTime() - bufferMs;
};

const refreshZoomAccessToken = async (
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: Date } | null> => {
  const clientId = process.env.ZOOM_OAUTH_CLIENT_ID;
  const clientSecret = process.env.ZOOM_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    loggers.auth.error('Missing Zoom OAuth credentials for token refresh');
    return null;
  }

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      loggers.auth.error('Zoom token refresh HTTP error', { status: res.status });
      return null;
    }

    const data = await res.json() as { access_token: string; expires_in?: number };
    if (!data.access_token) {
      loggers.auth.error('Zoom token refresh returned no access token');
      return null;
    }

    return {
      accessToken: data.access_token,
      expiresAt: data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : new Date(Date.now() + 3600 * 1000),
    };
  } catch (err) {
    loggers.auth.error('Zoom token refresh failed', err instanceof Error ? err : new Error(String(err)));
    return null;
  }
};

export const getValidZoomAccessToken = async (userId: string): Promise<TokenRefreshResult> => {
  const connection = await db.query.zoomConnections.findFirst({
    where: eq(zoomConnections.userId, userId),
  });

  if (!connection) {
    return { success: false, error: 'No Zoom connection found', requiresReauth: true };
  }

  if (connection.status !== 'active') {
    return { success: false, error: `Zoom connection is ${connection.status}`, requiresReauth: true };
  }

  let decryptedAccessToken: string;
  try {
    decryptedAccessToken = await decrypt(connection.accessToken);
  } catch (err) {
    loggers.auth.error('Failed to decrypt Zoom access token', err instanceof Error ? err : new Error(String(err)));
    return { success: false, error: 'Token decryption failed', requiresReauth: true };
  }

  if (!isTokenExpired(connection.tokenExpiresAt)) {
    return { success: true, accessToken: decryptedAccessToken };
  }

  if (!connection.refreshToken) {
    loggers.auth.warn('Zoom token expired and no refresh token available', { userId });
    return { success: false, error: 'Token expired, re-authentication required', requiresReauth: true };
  }

  let decryptedRefreshToken: string;
  try {
    decryptedRefreshToken = await decrypt(connection.refreshToken);
  } catch (err) {
    loggers.auth.error('Failed to decrypt Zoom refresh token', err instanceof Error ? err : new Error(String(err)));
    return { success: false, error: 'Refresh token decryption failed', requiresReauth: true };
  }

  loggers.auth.info('Refreshing expired Zoom access token', { userId });
  const refreshResult = await refreshZoomAccessToken(decryptedRefreshToken);

  if (!refreshResult) {
    await db
      .update(zoomConnections)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(zoomConnections.userId, userId));
    return { success: false, error: 'Token refresh failed, re-authentication required', requiresReauth: true };
  }

  const encryptedAccessToken = await encrypt(refreshResult.accessToken);
  await db
    .update(zoomConnections)
    .set({
      accessToken: encryptedAccessToken,
      tokenExpiresAt: refreshResult.expiresAt,
      status: 'active',
      updatedAt: new Date(),
    })
    .where(eq(zoomConnections.userId, userId));

  loggers.auth.info('Zoom access token refreshed', { userId });
  return { success: true, accessToken: refreshResult.accessToken };
};

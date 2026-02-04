/**
 * Google Calendar Token Refresh
 *
 * Pure functions for token validation and refresh logic.
 * IO functions handle database and Google API interactions.
 *
 * Zero-trust principles:
 * - Tokens are always encrypted at rest
 * - Decryption only happens when needed for API calls
 * - Refresh happens server-side, never exposed to client
 */

import { db, googleCalendarConnections, eq, type GoogleCalendarConnection } from '@pagespace/db';
import { encrypt, decrypt } from '@pagespace/lib';
import { loggers } from '@pagespace/lib/server';
import { OAuth2Client } from 'google-auth-library';

// Buffer time before expiration to refresh (5 minutes)
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export type TokenRefreshResult =
  | { success: true; accessToken: string }
  | { success: false; error: string; requiresReauth: boolean };

/**
 * Pure function: Check if token needs refresh
 */
export const isTokenExpired = (expiresAt: Date, bufferMs: number = TOKEN_REFRESH_BUFFER_MS): boolean => {
  return Date.now() >= expiresAt.getTime() - bufferMs;
};

/**
 * Pure function: Build refresh request parameters
 */
export const buildRefreshParams = (
  refreshToken: string,
  clientId: string,
  clientSecret: string
): URLSearchParams => {
  return new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
};

/**
 * IO function: Refresh access token using Google OAuth
 */
export const refreshAccessToken = async (
  refreshToken: string
): Promise<{ accessToken: string; expiresAt: Date } | null> => {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    loggers.auth.error('Missing OAuth credentials for token refresh');
    return null;
  }

  try {
    const client = new OAuth2Client(clientId, clientSecret);
    client.setCredentials({ refresh_token: refreshToken });

    const { credentials } = await client.refreshAccessToken();

    if (!credentials.access_token) {
      loggers.auth.error('No access token returned from refresh');
      return null;
    }

    const expiresAt = credentials.expiry_date
      ? new Date(credentials.expiry_date)
      : new Date(Date.now() + 3600 * 1000); // Default 1 hour

    return {
      accessToken: credentials.access_token,
      expiresAt,
    };
  } catch (error) {
    loggers.auth.error('Token refresh failed', error as Error);
    return null;
  }
};

/**
 * IO function: Get valid access token for a user
 *
 * This is the main entry point for getting a usable access token.
 * It handles:
 * 1. Fetching the connection from DB
 * 2. Decrypting tokens
 * 3. Refreshing if expired
 * 4. Re-encrypting and storing new tokens
 * 5. Returning a valid access token
 */
export const getValidAccessToken = async (userId: string): Promise<TokenRefreshResult> => {
  try {
    // Fetch connection from DB
    const connection = await db.query.googleCalendarConnections.findFirst({
      where: eq(googleCalendarConnections.userId, userId),
    });

    if (!connection) {
      return { success: false, error: 'No Google Calendar connection found', requiresReauth: true };
    }

    if (connection.status !== 'active') {
      return {
        success: false,
        error: `Connection is ${connection.status}: ${connection.statusMessage || 'Unknown error'}`,
        requiresReauth: connection.status === 'expired' || connection.status === 'error',
      };
    }

    // Decrypt tokens
    let decryptedAccessToken: string;
    let decryptedRefreshToken: string;

    try {
      decryptedAccessToken = await decrypt(connection.accessToken);
      decryptedRefreshToken = await decrypt(connection.refreshToken);
    } catch (error) {
      loggers.auth.error('Failed to decrypt tokens', error as Error);
      // Mark connection as error
      await updateConnectionStatus(userId, 'error', 'Token decryption failed');
      return { success: false, error: 'Token decryption failed', requiresReauth: true };
    }

    // Check if token is still valid
    if (!isTokenExpired(connection.tokenExpiresAt)) {
      return { success: true, accessToken: decryptedAccessToken };
    }

    // Token expired, refresh it
    loggers.auth.info('Refreshing expired Google Calendar token', { userId });

    const refreshResult = await refreshAccessToken(decryptedRefreshToken);

    if (!refreshResult) {
      // Refresh failed, mark connection as expired
      await updateConnectionStatus(userId, 'expired', 'Token refresh failed');
      return { success: false, error: 'Token refresh failed', requiresReauth: true };
    }

    // Encrypt new access token
    const encryptedAccessToken = await encrypt(refreshResult.accessToken);

    // Update connection with new token
    await db
      .update(googleCalendarConnections)
      .set({
        accessToken: encryptedAccessToken,
        tokenExpiresAt: refreshResult.expiresAt,
        status: 'active',
        statusMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(googleCalendarConnections.userId, userId));

    loggers.auth.info('Google Calendar token refreshed successfully', { userId });

    return { success: true, accessToken: refreshResult.accessToken };
  } catch (error) {
    loggers.auth.error('Unexpected error in getValidAccessToken', error as Error);
    return { success: false, error: 'Unexpected error', requiresReauth: false };
  }
};

/**
 * IO function: Update connection status
 */
export const updateConnectionStatus = async (
  userId: string,
  status: GoogleCalendarConnection['status'],
  statusMessage: string | null
): Promise<void> => {
  await db
    .update(googleCalendarConnections)
    .set({
      status,
      statusMessage,
      updatedAt: new Date(),
    })
    .where(eq(googleCalendarConnections.userId, userId));
};

/**
 * IO function: Get connection status for a user
 */
export const getConnectionStatus = async (
  userId: string
): Promise<{
  connected: boolean;
  status: GoogleCalendarConnection['status'] | null;
  googleEmail: string | null;
  lastSyncAt: Date | null;
  lastSyncError: string | null;
}> => {
  const connection = await db.query.googleCalendarConnections.findFirst({
    where: eq(googleCalendarConnections.userId, userId),
    columns: {
      status: true,
      googleEmail: true,
      lastSyncAt: true,
      lastSyncError: true,
    },
  });

  if (!connection) {
    return {
      connected: false,
      status: null,
      googleEmail: null,
      lastSyncAt: null,
      lastSyncError: null,
    };
  }

  return {
    connected: connection.status === 'active',
    status: connection.status,
    googleEmail: connection.googleEmail,
    lastSyncAt: connection.lastSyncAt,
    lastSyncError: connection.lastSyncError,
  };
};

/**
 * OAuth Utility Functions for Mobile Authentication
 *
 * This module provides shared OAuth verification and user management logic
 * that can be used across different providers (Google, Apple, GitHub, etc.)
 */

import { OAuth2Client } from 'google-auth-library';
import { users, drives, refreshTokens } from '@pagespace/db';
import { db, eq, or, count } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { slugify } from '@pagespace/lib/server';
import { decodeToken, getRefreshTokenMaxAge } from './auth-utils';
import { OAuthProvider, type OAuthUserInfo, type OAuthVerificationResult } from './oauth-types';
import { createWelcomeDocs } from './welcome-docs';
import { loggers } from './logger';

/**
 * Verify Google ID token and extract user information
 */
export async function verifyGoogleIdToken(idToken: string): Promise<OAuthVerificationResult> {
  try {
    if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
      return {
        success: false,
        error: 'Google OAuth client ID not configured',
      };
    }

    // Build array of valid client IDs (web + iOS)
    const validAudiences = [process.env.GOOGLE_OAUTH_CLIENT_ID];
    if (process.env.GOOGLE_OAUTH_IOS_CLIENT_ID) {
      validAudiences.push(process.env.GOOGLE_OAUTH_IOS_CLIENT_ID);
    }

    const client = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID);

    const ticket = await client.verifyIdToken({
      idToken,
      audience: validAudiences, // Accept tokens from both web and iOS clients
    });

    const payload = ticket.getPayload();

    if (!payload || !payload.email) {
      return {
        success: false,
        error: 'Invalid ID token: missing required claims',
      };
    }

    const userInfo: OAuthUserInfo = {
      providerId: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified || false,
      name: payload.name,
      picture: payload.picture,
      provider: OAuthProvider.GOOGLE,
    };

    return {
      success: true,
      userInfo,
    };
  } catch (error) {
    console.error('[OAuth] Google ID token verification failed:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Token verification failed',
    };
  }
}

/**
 * Verify Apple ID token and extract user information
 * TODO: Implement Apple Sign-In verification when needed
 */
export async function verifyAppleIdToken(idToken: string): Promise<OAuthVerificationResult> {
  // Placeholder for future Apple Sign-In implementation
  return {
    success: false,
    error: 'Apple Sign-In not yet implemented',
  };
}

/**
 * Main OAuth verification dispatcher
 * Routes to provider-specific verification function
 */
export async function verifyOAuthIdToken(
  provider: OAuthProvider,
  idToken: string
): Promise<OAuthVerificationResult> {
  switch (provider) {
    case OAuthProvider.GOOGLE:
      return verifyGoogleIdToken(idToken);
    case OAuthProvider.APPLE:
      return verifyAppleIdToken(idToken);
    default:
      return {
        success: false,
        error: `Unsupported OAuth provider: ${provider}`,
      };
  }
}

/**
 * Create new user or link OAuth provider to existing user
 * Returns the user record with updated OAuth information
 */
export async function createOrLinkOAuthUser(userInfo: OAuthUserInfo) {
  const { providerId, email, emailVerified, name, picture, provider } = userInfo;

  // Create fallback name if provider doesn't provide one
  const userName = name || email.split('@')[0] || 'User';

  // Map provider enum to database provider column
  const providerDbValue = provider === OAuthProvider.GOOGLE ? 'google'
    : provider === OAuthProvider.APPLE ? 'apple'
    : 'email';

  // Check if user exists by provider ID or email
  let user = await db.query.users.findFirst({
    where: or(
      // For Google: check googleId
      provider === OAuthProvider.GOOGLE ? eq(users.googleId, providerId) : undefined,
      // For all providers: check email
      eq(users.email, email)
    ),
  });

  if (user) {
    // Update existing user with OAuth provider ID if not set
    const updateData: Record<string, any> = {
      emailVerified: emailVerified ? new Date() : user.emailVerified,
    };

    // Update provider-specific ID
    if (provider === OAuthProvider.GOOGLE && !user.googleId) {
      updateData.googleId = providerId;
    }

    // Update provider field
    // If user has a password, they signed up with email, so mark as 'both'
    // Otherwise, just use the OAuth provider
    updateData.provider = user.password ? 'both' : providerDbValue;

    // Update name if missing
    if (!user.name) {
      updateData.name = userName;
    }

    // Update image if different
    if (picture && user.image !== picture) {
      updateData.image = picture;
    }

    // Apply updates if there are any changes
    if (Object.keys(updateData).length > 0) {
      await db.update(users)
        .set(updateData)
        .where(eq(users.id, user.id));

      // Refetch user to get updated data
      user = await db.query.users.findFirst({
        where: eq(users.id, user.id),
      }) || user;
    }
  } else {
    // Create new user
    const baseUserData = {
      id: createId(),
      name: userName,
      email,
      emailVerified: emailVerified ? new Date() : null,
      image: picture || null,
      provider: providerDbValue as 'email' | 'google' | 'both',
      tokenVersion: 0,
      role: 'user' as const,
      storageUsedBytes: 0,
      subscriptionTier: 'free' as const,
    };

    // Add provider-specific ID based on provider
    const newUserData = provider === OAuthProvider.GOOGLE
      ? { ...baseUserData, googleId: providerId }
      : baseUserData;

    const [newUser] = await db.insert(users)
      .values(newUserData)
      .returning();

    user = newUser;
  }

  // Check if user needs a personal drive
  const userDriveCount = await db
    .select({ count: count() })
    .from(drives)
    .where(eq(drives.ownerId, user.id));

  if (userDriveCount[0]?.count === 0) {
    // Create personal drive for new user
    const driveName = `${user.name || userName}'s Drive`;
    const driveSlug = slugify(driveName);

    const drive = await db.insert(drives).values({
      name: driveName,
      slug: driveSlug,
      ownerId: user.id,
      updatedAt: new Date(),
    }).returning().then(res => res[0]);

    // Create welcome documentation in the new drive
    try {
      await createWelcomeDocs(drive.id);
      loggers.auth.info('Welcome docs created for new OAuth user', { userId: user.id, driveId: drive.id, provider });
    } catch (error) {
      // Don't fail signup if welcome docs creation fails
      loggers.auth.error('Failed to create welcome docs', error as Error, { userId: user.id, driveId: drive.id });
    }
  }

  return user;
}

/**
 * Save refresh token to database
 */
export async function saveRefreshToken(
  token: string,
  userId: string,
  options: {
    device?: string | null;
    ip?: string | null;
    userAgent?: string | null;
    platform?: 'web' | 'desktop' | 'ios' | 'android' | null;
    deviceTokenId?: string | null;
    expiresAt?: Date | null;
    lastUsedAt?: Date | null;
  } = {}
) {
  let expiresAt = options.expiresAt ?? null;

  if (!expiresAt) {
    const payload = await decodeToken(token);
    expiresAt = payload?.exp
      ? new Date(payload.exp * 1000)
      : new Date(Date.now() + getRefreshTokenMaxAge() * 1000);
  }

  const lastUsedAt = options.lastUsedAt ?? new Date();

  await db.insert(refreshTokens).values({
    id: createId(),
    token,
    userId,
    device: options.device ?? null,
    userAgent: options.userAgent ?? options.device ?? null,
    ip: options.ip ?? null,
    platform: options.platform ?? null,
    deviceTokenId: options.deviceTokenId ?? null,
    expiresAt,
    lastUsedAt,
  });
}

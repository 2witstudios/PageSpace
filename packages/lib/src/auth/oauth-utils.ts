/**
 * OAuth Utility Functions for Mobile Authentication
 *
 * This module provides shared OAuth verification and user management logic
 * that can be used across different providers (Google, Apple, GitHub, etc.)
 */

import { OAuth2Client } from 'google-auth-library';
import appleSignIn from 'apple-signin-auth';
import { users, drives } from '@pagespace/db';
import { db, eq, or, count } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { slugify } from '@pagespace/lib/server';
import { loggers } from '../logging/logger-config';
import { OAuthProvider, type OAuthUserInfo, type OAuthVerificationResult } from './oauth-types';

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
    // SECURITY: Never log token values - only log error type
    loggers.auth.error('Google ID token verification failed', error as Error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Token verification failed',
    };
  }
}

/**
 * Verify Apple ID token and extract user information
 * Uses Apple's public keys to verify the JWT signature
 */
export async function verifyAppleIdToken(idToken: string): Promise<OAuthVerificationResult> {
  try {
    // Build array of valid client IDs (iOS app + web service ID)
    const validClientIds: string[] = [];
    if (process.env.APPLE_CLIENT_ID) {
      validClientIds.push(process.env.APPLE_CLIENT_ID);
    }
    if (process.env.APPLE_SERVICE_ID) {
      validClientIds.push(process.env.APPLE_SERVICE_ID);
    }

    if (validClientIds.length === 0) {
      return {
        success: false,
        error: 'Apple Sign-In not configured',
      };
    }

    // Verify the ID token with Apple's public keys
    // The library fetches Apple's public keys and validates the JWT
    const payload = await appleSignIn.verifyIdToken(idToken, {
      audience: validClientIds, // Accept tokens from both iOS app and web
      ignoreExpiration: false,
    });

    if (!payload || !payload.email) {
      return {
        success: false,
        error: 'Invalid ID token: missing required claims',
      };
    }

    // Apple provides 'sub' as the unique user identifier
    // Note: Apple may provide name only on first sign-in, it's not in the ID token
    // The name comes from the authorization response, not the token itself
    const userInfo: OAuthUserInfo = {
      providerId: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === 'true' || payload.email_verified === true,
      // Apple doesn't include name in the ID token - it comes from the auth response
      // We'll handle this in the native endpoint by accepting name from the request
      name: undefined,
      picture: undefined, // Apple doesn't provide profile pictures
      provider: OAuthProvider.APPLE,
    };

    return {
      success: true,
      userInfo,
    };
  } catch (error) {
    // SECURITY: Never log token values - only log error type
    loggers.auth.error('Apple ID token verification failed', error as Error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Token verification failed',
    };
  }
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
      // For Apple: check appleId
      provider === OAuthProvider.APPLE ? eq(users.appleId, providerId) : undefined,
      // For all providers: check email
      eq(users.email, email)
    ),
  });

  if (user) {
    // Update existing user with OAuth provider ID if not set
    const updateData: Partial<{
      emailVerified: Date | null;
      googleId: string;
      appleId: string;
      provider: 'email' | 'google' | 'apple' | 'both';
      name: string;
      image: string;
    }> = {
      emailVerified: emailVerified ? new Date() : user.emailVerified,
    };

    // Update provider-specific ID
    if (provider === OAuthProvider.GOOGLE && !user.googleId) {
      updateData.googleId = providerId;
    }
    if (provider === OAuthProvider.APPLE && !user.appleId) {
      updateData.appleId = providerId;
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
      provider: providerDbValue as 'email' | 'google' | 'apple' | 'both',
      tokenVersion: 0,
      role: 'user' as const,
      storageUsedBytes: 0,
      subscriptionTier: 'free' as const,
    };

    // Add provider-specific ID based on provider
    const newUserData = provider === OAuthProvider.GOOGLE
      ? { ...baseUserData, googleId: providerId }
      : provider === OAuthProvider.APPLE
      ? { ...baseUserData, appleId: providerId }
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

    await db.insert(drives).values({
      name: driveName,
      slug: driveSlug,
      ownerId: user.id,
      updatedAt: new Date(),
    });
  }

  return user;
}

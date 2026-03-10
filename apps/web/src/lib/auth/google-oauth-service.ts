/**
 * Google OAuth Service
 *
 * Consolidated Google authentication logic shared across:
 * - /api/auth/google/callback (OAuth callback with code exchange)
 * - /api/auth/google/one-tap (One-tap Sign-In with credential)
 * - /api/auth/google/native (Native iOS/Android with ID token)
 * - /api/auth/mobile/oauth/google/exchange (Mobile token exchange)
 */

import { OAuth2Client } from 'google-auth-library';
import { users, db, eq, or } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { loggers } from '@pagespace/lib/server';
import { resolveGoogleAvatarImage } from './google-avatar';

// Factory functions for OAuth2 clients (avoids singleton issues in tests/edge)
let webClient: OAuth2Client | null = null;
let verifyClient: OAuth2Client | null = null;

/**
 * Get OAuth2 client for web flow (with redirect URI)
 */
export function getGoogleWebClient(): OAuth2Client {
  if (!webClient) {
    webClient = new OAuth2Client(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      process.env.GOOGLE_OAUTH_REDIRECT_URI
    );
  }
  return webClient;
}

/**
 * Get OAuth2 client for token verification (no redirect URI needed)
 */
export function getGoogleVerifyClient(): OAuth2Client {
  if (!verifyClient) {
    verifyClient = new OAuth2Client(process.env.GOOGLE_OAUTH_CLIENT_ID);
  }
  return verifyClient;
}

export interface GoogleUserInfo {
  googleId: string;
  email: string;
  name: string | undefined;
  picture: string | undefined;
  emailVerified: boolean;
}

export interface GoogleTokenVerificationResult {
  success: boolean;
  userInfo?: GoogleUserInfo;
  error?: string;
}

/**
 * Verify Google ID token (used by one-tap, native, and mobile exchange)
 */
export async function verifyGoogleIdToken(
  idToken: string,
  audiences?: string[]
): Promise<GoogleTokenVerificationResult> {
  const client = getGoogleVerifyClient();
  const audience = audiences || [process.env.GOOGLE_OAUTH_CLIENT_ID!];

  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience,
    });

    const payload = ticket.getPayload();
    if (!payload?.email) {
      return { success: false, error: 'Invalid token - missing email' };
    }

    return {
      success: true,
      userInfo: {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
        emailVerified: payload.email_verified ?? false,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Token verification failed';
    loggers.auth.warn('Google ID token verification failed', { error: message });
    return { success: false, error: message };
  }
}

/**
 * Exchange authorization code for tokens (used by callback route)
 */
export async function exchangeGoogleAuthCode(authCode: string): Promise<{
  success: boolean;
  userInfo?: GoogleUserInfo;
  error?: string;
}> {
  const client = getGoogleWebClient();

  try {
    const { tokens } = await client.getToken(authCode);

    if (!tokens.id_token) {
      return { success: false, error: 'No ID token received from Google' };
    }

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_OAUTH_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    if (!payload?.email) {
      return { success: false, error: 'Invalid ID token payload' };
    }

    return {
      success: true,
      userInfo: {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
        emailVerified: payload.email_verified ?? false,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Token exchange failed';
    loggers.auth.error('Google auth code exchange failed', error as Error);
    return { success: false, error: message };
  }
}

export interface UserWithGoogleData {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  emailVerified: Date | null;
  googleId: string | null;
  provider: string | null;
  password: string | null;
  tokenVersion: number;
  role: 'user' | 'admin';
}

export interface FindOrCreateUserResult {
  user: UserWithGoogleData;
  isNew: boolean;
}

/**
 * Find existing user by Google ID or email, or create a new user.
 * Uses database transaction to prevent race conditions on concurrent requests.
 * Handles avatar resolution and profile updates.
 */
export async function findOrCreateGoogleUser(
  userInfo: GoogleUserInfo
): Promise<FindOrCreateUserResult> {
  const { googleId, email, name, picture, emailVerified } = userInfo;
  const userName = name || email.split('@')[0] || 'User';

  return db.transaction(async (tx) => {
    // Lock the user row(s) during find to prevent concurrent creation
    const existingUser = await tx.query.users.findFirst({
      where: or(eq(users.googleId, googleId), eq(users.email, email)),
    });

    if (existingUser) {
      const resolvedImage = await resolveGoogleAvatarImage({
        userId: existingUser.id,
        pictureUrl: picture,
        existingImage: existingUser.image,
      });

      const needsUpdate =
        !existingUser.googleId ||
        !existingUser.name ||
        existingUser.image !== resolvedImage ||
        (emailVerified && !existingUser.emailVerified);

      if (needsUpdate) {
        loggers.auth.info('Updating existing user via Google OAuth', { email });
        await tx
          .update(users)
          .set({
            googleId: googleId || existingUser.googleId,
            provider: existingUser.password ? 'both' : 'google',
            name: existingUser.name || userName,
            image: resolvedImage,
            emailVerified: emailVerified ? new Date() : existingUser.emailVerified,
          })
          .where(eq(users.id, existingUser.id));

        const updated = await tx.query.users.findFirst({
          where: eq(users.id, existingUser.id),
        });
        return { user: (updated || existingUser) as UserWithGoogleData, isNew: false };
      }

      return { user: existingUser as UserWithGoogleData, isNew: false };
    }

    // Create new user within transaction
    loggers.auth.info('Creating new user via Google OAuth', { email });

    const [newUser] = await tx
      .insert(users)
      .values({
        id: createId(),
        name: userName,
        email,
        emailVerified: emailVerified ? new Date() : null,
        image: null,
        googleId,
        provider: 'google',
        tokenVersion: 0,
        role: 'user',
        storageUsedBytes: 0,
        subscriptionTier: 'free',
      })
      .returning();

    // Resolve avatar for new user
    const resolvedImage = await resolveGoogleAvatarImage({
      userId: newUser.id,
      pictureUrl: picture,
      existingImage: newUser.image,
    });

    if (resolvedImage !== (newUser.image ?? null)) {
      await tx
        .update(users)
        .set({ image: resolvedImage })
        .where(eq(users.id, newUser.id));
      return { user: { ...newUser, image: resolvedImage } as UserWithGoogleData, isNew: true };
    }

    return { user: newUser as UserWithGoogleData, isNew: true };
  });
}

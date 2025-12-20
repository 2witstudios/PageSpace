/**
 * Repository for authentication-related database operations.
 * This seam isolates query-builder details from route handlers,
 * enabling proper unit testing of auth routes without ORM chain mocking.
 */

import { db, users, refreshTokens, deviceTokens, eq, and, isNull, sql } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';

// Types for repository operations
export interface User {
  id: string;
  email: string;
  name: string | null;
  password: string | null;
  tokenVersion: number;
  role: 'user' | 'admin';
  image?: string | null;
  provider?: string | null;
  googleId?: string | null;
  emailVerified?: Date | null;
}

export interface RefreshTokenRecord {
  id: string;
  token: string;
  userId: string;
  user: User;
  expiresAt: Date;
}

export type PlatformType = 'web' | 'desktop' | 'ios' | 'android';

export interface CreateRefreshTokenInput {
  token: string;
  userId: string;
  device?: string | null;
  userAgent?: string | null;
  ip?: string;
  expiresAt: Date;
  deviceTokenId?: string;
  platform?: PlatformType;
}

export const authRepository = {
  /**
   * Find a user by email address
   */
  async findUserByEmail(email: string): Promise<User | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });
    return (user as User) || null;
  },

  /**
   * Find a user by ID
   */
  async findUserById(userId: string): Promise<User | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    return (user as User) || null;
  },

  /**
   * Store a new refresh token in the database
   */
  async createRefreshToken(input: CreateRefreshTokenInput): Promise<void> {
    await db.insert(refreshTokens).values({
      id: createId(),
      token: input.token,
      userId: input.userId,
      device: input.device,
      userAgent: input.userAgent,
      ip: input.ip,
      lastUsedAt: new Date(),
      platform: input.platform ?? 'web',
      expiresAt: input.expiresAt,
      deviceTokenId: input.deviceTokenId,
    });
  },

  /**
   * Find a refresh token with its associated user (for refresh flow)
   */
  async findRefreshTokenWithUser(
    token: string
  ): Promise<RefreshTokenRecord | null> {
    const record = await db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.token, token),
      with: {
        user: true,
      },
    });
    return (record as RefreshTokenRecord) || null;
  },

  /**
   * Delete a refresh token by its value (for token rotation)
   */
  async deleteRefreshToken(token: string): Promise<void> {
    await db.delete(refreshTokens).where(eq(refreshTokens.token, token));
  },

  /**
   * Delete all refresh tokens for a user (for logout all devices)
   */
  async deleteAllUserRefreshTokens(userId: string): Promise<void> {
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  },

  /**
   * Increment user's token version (invalidates all existing tokens)
   */
  async incrementUserTokenVersion(userId: string): Promise<void> {
    await db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, userId));
  },

  /**
   * Revoke all device tokens for a user (marks as revoked)
   */
  async revokeAllUserDeviceTokens(userId: string): Promise<void> {
    await db
      .update(deviceTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(eq(deviceTokens.userId, userId), isNull(deviceTokens.revokedAt))
      );
  },

  /**
   * Update user's token version (for security invalidation)
   */
  async updateUserTokenVersion(
    userId: string,
    newVersion: number
  ): Promise<void> {
    await db
      .update(users)
      .set({ tokenVersion: newVersion })
      .where(eq(users.id, userId));
  },
};

export type AuthRepository = typeof authRepository;

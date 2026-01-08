/**
 * Repository for authentication-related database operations.
 * This seam isolates query-builder details from route handlers,
 * enabling proper unit testing of auth routes without ORM chain mocking.
 */

import {
  db,
  users,
  refreshTokens,
  deviceTokens,
  eq,
  and,
  isNull,
  sql,
  type InferSelectModel,
} from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { hashToken, getTokenPrefix } from '@pagespace/lib/auth';

// Types derived from Drizzle schema - ensures type safety without manual definitions
export type User = InferSelectModel<typeof users>;
export type RefreshToken = InferSelectModel<typeof refreshTokens>;
export type RefreshTokenWithUser = RefreshToken & { user: User };

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
    return user ?? null;
  },

  /**
   * Find a user by ID
   */
  async findUserById(userId: string): Promise<User | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    return user ?? null;
  },

  /**
   * Store a new refresh token in the database
   * SECURITY: Only hash stored, never plaintext - hash computed here from raw token
   */
  async createRefreshToken(input: CreateRefreshTokenInput): Promise<void> {
    const tokenHash = hashToken(input.token);
    await db.insert(refreshTokens).values({
      id: createId(),
      token: tokenHash, // Store hash, NOT plaintext
      tokenHash: tokenHash,
      tokenPrefix: getTokenPrefix(input.token),
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
   * Uses dual-mode lookup: hash first (new tokens), plaintext fallback (legacy migration)
   */
  async findRefreshTokenWithUser(
    token: string
  ): Promise<RefreshTokenWithUser | null> {
    const tokenHash = hashToken(token);

    // Try hash lookup first (new tokens)
    let record = await db.query.refreshTokens.findFirst({
      where: eq(refreshTokens.tokenHash, tokenHash),
      with: {
        user: true,
      },
    });

    // Fall back to plaintext lookup (legacy tokens during migration)
    if (!record) {
      record = await db.query.refreshTokens.findFirst({
        where: eq(refreshTokens.token, token),
        with: {
          user: true,
        },
      });
    }

    return record ?? null;
  },

  /**
   * Delete a refresh token by its value (for token rotation)
   * Uses dual-mode lookup: hash first (new tokens), plaintext fallback (legacy migration)
   */
  async deleteRefreshToken(token: string): Promise<void> {
    const tokenHash = hashToken(token);

    // Try to delete by hash first
    const result = await db.delete(refreshTokens).where(eq(refreshTokens.tokenHash, tokenHash)).returning();

    // If no rows deleted by hash, try plaintext (legacy tokens)
    if (result.length === 0) {
      await db.delete(refreshTokens).where(eq(refreshTokens.token, token));
    }
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

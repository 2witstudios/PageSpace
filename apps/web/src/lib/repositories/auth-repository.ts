/**
 * Repository for authentication-related database operations.
 * This seam isolates query-builder details from route handlers,
 * enabling proper unit testing of auth routes without ORM chain mocking.
 */

import { db } from '@pagespace/db/db'
import { eq, and, or, isNull, sql, type InferSelectModel, type InferInsertModel } from '@pagespace/db/operators'
import { users, deviceTokens } from '@pagespace/db/schema/auth';

// Types derived from Drizzle schema - ensures type safety without manual definitions
export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

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

  /**
   * Find a user by Google ID or email (for OAuth login/signup)
   */
  async findUserByGoogleIdOrEmail(googleId: string, email: string): Promise<User | null> {
    const user = await db.query.users.findFirst({
      where: or(eq(users.googleId, googleId), eq(users.email, email)),
    });
    return user ?? null;
  },

  /**
   * Find a user by Apple ID or email (for OAuth login/signup)
   */
  async findUserByAppleIdOrEmail(appleId: string, email: string): Promise<User | null> {
    const user = await db.query.users.findFirst({
      where: or(eq(users.appleId, appleId), eq(users.email, email)),
    });
    return user ?? null;
  },

  /**
   * Create a new user and return the created record
   */
  async createUser(values: NewUser): Promise<User> {
    const [newUser] = await db.insert(users).values(values).returning();
    return newUser;
  },

  /**
   * Update user fields by ID
   */
  async updateUser(userId: string, fields: Partial<NewUser>): Promise<void> {
    await db.update(users).set(fields).where(eq(users.id, userId));
  },
};

export type AuthRepository = typeof authRepository;

/**
 * Repository for authentication-related database operations.
 * This seam isolates query-builder details from route handlers,
 * enabling proper unit testing of auth routes without ORM chain mocking.
 */

import { db } from '@pagespace/db/db'
import { eq, and, isNull, sql, type InferSelectModel, type InferInsertModel } from '@pagespace/db/operators'
import { users, deviceTokens } from '@pagespace/db/schema/auth';
import { userEmailMatch, prepareUserWrite, decryptUserRow } from '@pagespace/lib/auth/user-repository';

// Types derived from Drizzle schema - ensures type safety without manual definitions
export type User = InferSelectModel<typeof users>;
export type NewUser = InferInsertModel<typeof users>;

export const authRepository = {
  /**
   * Find a user by email address
   */
  async findUserByEmail(email: string): Promise<User | null> {
    const user = await db.query.users.findFirst({
      where: userEmailMatch(email),
    });
    return user ? decryptUserRow(user) : null;
  },

  /**
   * Find a user by ID
   */
  async findUserById(userId: string): Promise<User | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    return user ? decryptUserRow(user) : null;
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
   * Find a user by Google subject id (OAuth provider identity).
   *
   * SECURITY: provider-subject and email lookups are kept SEPARATE so the
   * account-match decision (`resolveOAuthMatch`) can require a verified email
   * before ever linking by email. See audit finding M5.
   */
  async findUserByGoogleId(googleId: string): Promise<User | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.googleId, googleId),
    });
    return user ? decryptUserRow(user) : null;
  },

  /**
   * Find a user by Apple subject id (OAuth provider identity).
   *
   * SECURITY: see {@link findUserByGoogleId} — subject and email lookups are
   * intentionally separate to enforce the verified-email link rule (M5).
   */
  async findUserByAppleId(appleId: string): Promise<User | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.appleId, appleId),
    });
    return user ? decryptUserRow(user) : null;
  },

  /**
   * Create a new user and return the created record
   */
  async createUser(values: NewUser): Promise<User> {
    const [newUser] = await db.insert(users).values(await prepareUserWrite(values)).returning();
    // Decrypt PII at the edge so callers see plaintext email/name.
    return decryptUserRow(newUser);
  },

  /**
   * Update user fields by ID
   */
  async updateUser(userId: string, fields: Partial<NewUser>): Promise<void> {
    // Encrypt email/name + recompute emailBidx (when email present) per the flag.
    await db.update(users).set(await prepareUserWrite(fields)).where(eq(users.id, userId));
  },
};

export type AuthRepository = typeof authRepository;

/**
 * Auth Repository - Clean seam for authentication operations
 *
 * Provides testable boundary for auth-related database operations.
 * Tests should mock this repository, not the ORM chains.
 *
 * User type is derived from the Drizzle schema to ensure type safety
 * and prevent mismatches between the interface and database columns.
 */

import { db, users, eq, sql, InferSelectModel } from '@pagespace/db';

// Derive User type directly from the schema - ensures type safety
export type User = InferSelectModel<typeof users>;

// Subset type for auth operations that only need specific fields
export type AuthUser = Pick<
  User,
  'id' | 'email' | 'name' | 'password' | 'tokenVersion' | 'role' | 'emailVerified' | 'provider'
>;

export const authRepository = {
  /**
   * Find user by email address
   * Returns the full user record or null if not found
   */
  async findUserByEmail(email: string): Promise<User | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
    });
    return user ?? null;
  },

  /**
   * Find user by ID
   * Returns the full user record or null if not found
   */
  async findUserById(id: string): Promise<User | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, id),
    });
    return user ?? null;
  },

  /**
   * Find user by email with only auth-relevant fields
   * More efficient for login flows that don't need all columns
   */
  async findAuthUserByEmail(email: string): Promise<AuthUser | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: {
        id: true,
        email: true,
        name: true,
        password: true,
        tokenVersion: true,
        role: true,
        emailVerified: true,
        provider: true,
      },
    });
    return user ?? null;
  },

  /**
   * Find user by ID with only auth-relevant fields
   */
  async findAuthUserById(id: string): Promise<AuthUser | null> {
    const user = await db.query.users.findFirst({
      where: eq(users.id, id),
      columns: {
        id: true,
        email: true,
        name: true,
        password: true,
        tokenVersion: true,
        role: true,
        emailVerified: true,
        provider: true,
      },
    });
    return user ?? null;
  },

  /**
   * Increment user's token version to invalidate all existing tokens
   */
  async incrementTokenVersion(userId: string): Promise<void> {
    await db
      .update(users)
      .set({ tokenVersion: sql`${users.tokenVersion} + 1` })
      .where(eq(users.id, userId));
  },

  /**
   * Update user's email verification timestamp
   */
  async markEmailVerified(userId: string): Promise<void> {
    await db
      .update(users)
      .set({ emailVerified: new Date() })
      .where(eq(users.id, userId));
  },
};

export type AuthRepository = typeof authRepository;

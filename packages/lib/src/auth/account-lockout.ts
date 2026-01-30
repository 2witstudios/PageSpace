/**
 * Account Lockout
 *
 * Database-backed account lockout for repeated failed authentication attempts.
 * Locks accounts after 10 consecutive failed attempts for 15 minutes.
 *
 * This complements rate limiting by providing per-account protection that:
 * - Persists across server restarts
 * - Works regardless of IP changes (attacker switching IPs)
 * - Provides audit trail of failed attempts
 */

import { db, users } from '@pagespace/db';
import { eq, sql } from 'drizzle-orm';
import { loggers } from '../logging/logger-config';

// Lockout thresholds
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export interface AccountLockoutStatus {
  isLocked: boolean;
  failedAttempts: number;
  lockedUntil: Date | null;
  remainingAttempts: number;
}

export interface AccountLockoutResult {
  success: boolean;
  error?: string;
  lockedUntil?: Date;
}

/**
 * Check if an account is currently locked.
 * Returns lockout status without modifying the account.
 */
export async function getAccountLockoutStatus(
  userId: string
): Promise<AccountLockoutStatus> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: {
      failedLoginAttempts: true,
      lockedUntil: true,
    },
  });

  if (!user) {
    return {
      isLocked: false,
      failedAttempts: 0,
      lockedUntil: null,
      remainingAttempts: MAX_FAILED_ATTEMPTS,
    };
  }

  const now = new Date();
  const isLocked = user.lockedUntil !== null && user.lockedUntil > now;

  return {
    isLocked,
    failedAttempts: user.failedLoginAttempts,
    lockedUntil: user.lockedUntil,
    remainingAttempts: Math.max(0, MAX_FAILED_ATTEMPTS - user.failedLoginAttempts),
  };
}

/**
 * Check if account is locked by email.
 * Useful for login flows where we only have the email.
 */
export async function isAccountLockedByEmail(
  email: string
): Promise<{ isLocked: boolean; lockedUntil: Date | null }> {
  const user = await db.query.users.findFirst({
    where: eq(users.email, email.toLowerCase()),
    columns: {
      lockedUntil: true,
    },
  });

  if (!user) {
    return { isLocked: false, lockedUntil: null };
  }

  const now = new Date();
  const isLocked = user.lockedUntil !== null && user.lockedUntil > now;

  return {
    isLocked,
    lockedUntil: isLocked ? user.lockedUntil : null,
  };
}

/**
 * Record a failed login attempt and potentially lock the account.
 * Call this after a failed authentication attempt.
 *
 * @returns Result indicating if the account was locked
 */
export async function recordFailedLoginAttempt(
  userId: string
): Promise<AccountLockoutResult> {
  try {
    // First check if there's an expired lockout that needs to be reset
    const currentUser = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        lockedUntil: true,
        failedLoginAttempts: true,
      },
    });

    if (!currentUser) {
      return { success: false, error: 'User not found' };
    }

    // If lockout has expired, reset the counter before incrementing
    const now = new Date();
    const lockoutExpired = currentUser.lockedUntil !== null && currentUser.lockedUntil <= now;

    // Atomically update: reset to 1 if expired, otherwise increment
    const result = await db
      .update(users)
      .set({
        failedLoginAttempts: lockoutExpired ? 1 : sql`${users.failedLoginAttempts} + 1`,
        lockedUntil: lockoutExpired ? null : undefined, // Clear expired lockout
      })
      .where(eq(users.id, userId))
      .returning({
        failedLoginAttempts: users.failedLoginAttempts,
        email: users.email,
      });

    if (result.length === 0) {
      return { success: false, error: 'User not found' };
    }

    const { failedLoginAttempts, email } = result[0];

    // Check if we've hit the threshold
    if (failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);

      await db
        .update(users)
        .set({ lockedUntil })
        .where(eq(users.id, userId));

      loggers.api.warn('Account locked due to failed login attempts', {
        userId,
        email,
        failedAttempts: failedLoginAttempts,
        lockedUntil: lockedUntil.toISOString(),
      });

      return { success: true, lockedUntil };
    }

    loggers.api.info('Failed login attempt recorded', {
      userId,
      failedAttempts: failedLoginAttempts,
      remainingAttempts: MAX_FAILED_ATTEMPTS - failedLoginAttempts,
    });

    return { success: true };
  } catch (error) {
    loggers.api.error('Error recording failed login attempt', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false, error: 'Database error' };
  }
}

/**
 * Record failed login attempt by email (before we know the userId).
 * Useful when the email exists but password is wrong.
 */
export async function recordFailedLoginAttemptByEmail(
  email: string
): Promise<AccountLockoutResult> {
  try {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase()),
      columns: { id: true },
    });

    if (!user) {
      // Don't reveal if user exists
      return { success: true };
    }

    return recordFailedLoginAttempt(user.id);
  } catch (error) {
    loggers.api.error('Error recording failed login attempt by email', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false, error: 'Database error' };
  }
}

/**
 * Reset failed login attempts after successful authentication.
 * Call this after a successful login.
 */
export async function resetFailedLoginAttempts(userId: string): Promise<void> {
  try {
    await db
      .update(users)
      .set({
        failedLoginAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, userId));

    loggers.api.debug('Failed login attempts reset', { userId });
  } catch (error) {
    // Log but don't throw - this shouldn't block successful login
    loggers.api.error('Error resetting failed login attempts', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Manually unlock an account (admin action).
 */
export async function unlockAccount(userId: string): Promise<boolean> {
  try {
    await db
      .update(users)
      .set({
        failedLoginAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, userId));

    loggers.api.info('Account manually unlocked', { userId });
    return true;
  } catch (error) {
    loggers.api.error('Error unlocking account', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

// Export constants for testing
export const LOCKOUT_CONFIG = {
  MAX_FAILED_ATTEMPTS,
  LOCKOUT_DURATION_MS,
} as const;

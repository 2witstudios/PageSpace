/**
 * User Validator Service (P1-T2)
 *
 * Validates that users referenced in service tokens are still valid.
 * This prevents tokens created for deleted users from continuing
 * to access the processor service.
 *
 * Note: Service tokens are short-lived (typically 5 minutes) and use JTI
 * for replay protection, so tokenVersion validation is not required here.
 * The JTI mechanism already prevents reuse of stolen tokens.
 *
 * @module apps/processor/services/user-validator
 */

import { db, users, eq } from '@pagespace/db';

/**
 * Reasons why a user validation might fail
 */
export type UserValidationFailureReason =
  | 'invalid_input'
  | 'user_not_found'
  | 'user_suspended'
  | 'database_error';

/**
 * Result of validating a service user
 */
export type ServiceUserValidationResult =
  | {
      valid: true;
      userId: string;
      role: string;
    }
  | {
      valid: false;
      reason: UserValidationFailureReason;
    };

/**
 * Validate that a user referenced in a service token still exists.
 *
 * Checks:
 * 1. User exists in database
 * 2. User is not suspended
 *
 * Note: Token version validation is not performed here because:
 * - Service tokens are short-lived (5 minutes default)
 * - JTI (JWT ID) tracking prevents token reuse
 * - The web layer already validates tokenVersion before issuing service tokens
 *
 * @param userId - The user ID from the service token's `sub` claim
 * @returns Validation result with user info on success, or failure reason
 *
 * @example
 * ```typescript
 * const result = await validateServiceUser(claims.sub);
 * if (!result.valid) {
 *   return res.status(401).json({ error: `User validation failed: ${result.reason}` });
 * }
 * // User is valid, proceed with request
 * ```
 */
export async function validateServiceUser(
  userId: string
): Promise<ServiceUserValidationResult> {
  // Guard against empty/invalid input
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    return { valid: false, reason: 'invalid_input' };
  }

  try {
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        id: true,
        role: true,
        suspendedAt: true,
      },
    });

    // User not found
    if (!user) {
      return { valid: false, reason: 'user_not_found' };
    }

    // User suspended (administrative action)
    if (user.suspendedAt) {
      return { valid: false, reason: 'user_suspended' };
    }

    return {
      valid: true,
      userId: user.id,
      role: user.role,
    };
  } catch (error) {
    console.error('User validation error:', error);
    return { valid: false, reason: 'database_error' };
  }
}

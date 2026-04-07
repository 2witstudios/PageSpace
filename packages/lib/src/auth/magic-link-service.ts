/**
 * Magic Link Service
 *
 * Zero-trust passwordless authentication via email magic links.
 * Follows Result pattern for error handling and uses timing-safe comparisons.
 *
 * @module @pagespace/lib/auth/magic-link-service
 */

import { z } from 'zod';
import { db, users, verificationTokens, eq, and, isNull } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { generateToken, hashToken, getTokenPrefix } from './token-utils';
import { secureCompare } from './secure-compare';

// Token expiry: 5 minutes for magic links
export const MAGIC_LINK_EXPIRY_MINUTES = 5;

// Input validation schemas
const createMagicLinkSchema = z.object({
  email: z.string().email('Invalid email address'),
  platform: z.enum(['web', 'desktop']).optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
});

const verifyMagicLinkSchema = z.object({
  token: z.string().min(1).refine(
    (t) => t.startsWith('ps_magic_'),
    'Invalid magic link token format'
  ),
});

/** Metadata stored with desktop-initiated magic link tokens */
export interface DesktopMagicLinkMetadata {
  platform: 'desktop';
  deviceId: string;
  deviceName?: string;
}

// Result types following zero-trust pattern
export type MagicLinkError =
  | { code: 'VALIDATION_FAILED'; message: string }
  | { code: 'TOKEN_EXPIRED' }
  | { code: 'TOKEN_ALREADY_USED' }
  | { code: 'TOKEN_NOT_FOUND' }
  | { code: 'USER_SUSPENDED'; userId: string };

export type CreateMagicLinkResult =
  | { ok: true; data: { token: string; userId: string; isNewUser: boolean } }
  | { ok: false; error: MagicLinkError };

export type VerifyMagicLinkResult =
  | { ok: true; data: { userId: string; isNewUser: boolean; metadata?: string | null } }
  | { ok: false; error: MagicLinkError };

/**
 * Create a magic link token for passwordless authentication.
 *
 * Given an email for existing user, generates ps_magic_* token with 5-minute expiry.
 * Given an email for non-existent user, creates pending signup token.
 * Given a suspended user, returns USER_SUSPENDED error.
 *
 * @param input - Unknown input, validated with Zod
 * @returns Result with token or error
 */
export async function createMagicLinkToken(input: unknown): Promise<CreateMagicLinkResult> {
  // Validate input
  const parsed = createMagicLinkSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: parsed.error.issues[0]?.message ?? 'Invalid input',
      },
    };
  }

  const { email, platform, deviceId, deviceName } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();

  // Check if user exists
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, normalizedEmail),
    columns: { id: true, suspendedAt: true },
  });

  // If user is suspended, reject
  if (existingUser?.suspendedAt) {
    return {
      ok: false,
      error: { code: 'USER_SUSPENDED', userId: existingUser.id },
    };
  }

  let userId: string;
  let isNewUser = false;

  if (existingUser) {
    userId = existingUser.id;
  } else {
    // Create a temporary user for magic link signup
    // The user will be marked as pending until they complete verification
    // Handle race condition where concurrent requests try to create the same user
    try {
      const [newUser] = await db.insert(users).values({
        id: createId(),
        name: normalizedEmail.split('@')[0] ?? 'New User',
        email: normalizedEmail,
        provider: 'email',
        role: 'user',
        tokenVersion: 1,
      }).returning();
      userId = newUser.id;
      isNewUser = true;
    } catch (error: unknown) {
      // Handle unique constraint violation - another request created the user
      const isConstraintViolation =
        error instanceof Error &&
        (error.message.includes('unique constraint') ||
          error.message.includes('duplicate key') ||
          error.message.includes('UNIQUE constraint'));

      if (isConstraintViolation) {
        const [existingUserAfterRace] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, normalizedEmail));

        if (!existingUserAfterRace) {
          throw error; // Unexpected state, rethrow
        }
        userId = existingUserAfterRace.id;
        isNewUser = false;
      } else {
        throw error;
      }
    }
  }

  // Clean up old unused magic link tokens for this user
  await db
    .delete(verificationTokens)
    .where(
      and(
        eq(verificationTokens.userId, userId),
        eq(verificationTokens.type, 'magic_link'),
        isNull(verificationTokens.usedAt)
      )
    );

  // Generate secure token with ps_magic_ prefix
  const { token, hash, tokenPrefix } = generateToken('ps_magic');
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000);

  // Build metadata for desktop platform support
  const metadata = platform === 'desktop' && deviceId
    ? JSON.stringify({ platform, deviceId, deviceName })
    : undefined;

  // Store token hash (never plaintext)
  await db.insert(verificationTokens).values({
    id: createId(),
    userId,
    tokenHash: hash,
    tokenPrefix,
    type: 'magic_link',
    expiresAt,
    ...(metadata && { metadata }),
  });

  return {
    ok: true,
    data: { token, userId, isNewUser },
  };
}

/**
 * Verify a magic link token and return user info.
 *
 * Given a valid token, returns userId and isNewUser flag.
 * Given an expired token, returns TOKEN_EXPIRED error.
 * Given a used token, returns TOKEN_ALREADY_USED error.
 * Given a suspended user, returns USER_SUSPENDED error.
 *
 * SECURITY: Uses timing-safe hash comparison to prevent timing attacks.
 *
 * @param input - Unknown input, validated with Zod
 * @returns Result with user info or error
 */
export async function verifyMagicLinkToken(input: unknown): Promise<VerifyMagicLinkResult> {
  // Validate input format
  const parsed = verifyMagicLinkSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: parsed.error.issues[0]?.message ?? 'Invalid input',
      },
    };
  }

  const { token } = parsed.data;

  // Hash the provided token for lookup
  const tokenHash = hashToken(token);

  // Look up by hash (never by plaintext)
  const record = await db.query.verificationTokens.findFirst({
    where: eq(verificationTokens.tokenHash, tokenHash),
    with: {
      user: {
        columns: { id: true, suspendedAt: true, emailVerified: true },
      },
    },
  });

  if (!record) {
    return { ok: false, error: { code: 'TOKEN_NOT_FOUND' } };
  }

  // Check token type
  if (record.type !== 'magic_link') {
    return { ok: false, error: { code: 'TOKEN_NOT_FOUND' } };
  }

  // Check if already used
  if (record.usedAt) {
    return { ok: false, error: { code: 'TOKEN_ALREADY_USED' } };
  }

  // Check expiration
  if (record.expiresAt < new Date()) {
    return { ok: false, error: { code: 'TOKEN_EXPIRED' } };
  }

  // Check user exists and is not suspended
  if (!record.user) {
    return { ok: false, error: { code: 'TOKEN_NOT_FOUND' } };
  }

  if (record.user.suspendedAt) {
    return { ok: false, error: { code: 'USER_SUSPENDED', userId: record.userId } };
  }

  // SECURITY: Perform timing-safe comparison of hashes
  // This is defense-in-depth since we already did hash lookup
  const storedHash = record.tokenHash;
  if (!secureCompare(tokenHash, storedHash)) {
    return { ok: false, error: { code: 'TOKEN_NOT_FOUND' } };
  }

  // Mark token as used atomically with WHERE usedAt IS NULL
  // This prevents TOCTOU race where concurrent requests both pass validation
  const updateResult = await db
    .update(verificationTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(verificationTokens.id, record.id),
        isNull(verificationTokens.usedAt)
      )
    )
    .returning();

  // If no rows updated, another request already used this token
  if (updateResult.length === 0) {
    return { ok: false, error: { code: 'TOKEN_ALREADY_USED' } };
  }

  // Determine if this is a new user (no email verified yet)
  const isNewUser = record.user.emailVerified === null;

  return {
    ok: true,
    data: { userId: record.userId, isNewUser, metadata: record.metadata },
  };
}

/**
 * Magic Link Service
 *
 * Zero-trust passwordless authentication via email magic links.
 * Follows Result pattern for error handling and uses timing-safe comparisons.
 *
 * @module @pagespace/lib/auth/magic-link-service
 */

import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { eq, and, isNull } from '@pagespace/db/operators';
import { users, verificationTokens } from '@pagespace/db/schema/auth';
import { createId } from '@paralleldrive/cuid2';
import { generateToken, hashToken } from './token-utils';
import { secureCompare } from './secure-compare';

// Token expiry: 5 minutes for magic links
export const MAGIC_LINK_EXPIRY_MINUTES = 5;

// Drive invitations sit in inboxes — 7 days is the long-lived expiry the
// invite route uses when minting an email-payload magic link.
export const INVITATION_LINK_EXPIRY_MINUTES = 60 * 24 * 7;

// Hard ceiling on caller-supplied expiry to avoid effectively-immortal tokens.
const MAX_EXPIRY_MINUTES = 60 * 24 * 30;

// Input validation schemas
const createMagicLinkSchema = z.object({
  email: z.string().email('Invalid email address'),
  platform: z.enum(['web', 'desktop']).optional(),
  deviceId: z.string().optional(),
  deviceName: z.string().optional(),
  expiryMinutes: z.number().int().positive().max(
    MAX_EXPIRY_MINUTES,
    `expiryMinutes must not exceed ${MAX_EXPIRY_MINUTES} (30 days)`
  ).optional(),
}).refine(
  (data) => data.platform !== 'desktop' || !!data.deviceId,
  { message: 'deviceId is required for desktop platform' }
);

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
  | { code: 'USER_SUSPENDED'; userId: string }
  | { code: 'NO_ACCOUNT_FOUND' };

export type CreateMagicLinkResult =
  | { ok: true; data: { token: string; userId: string } }
  | { ok: false; error: MagicLinkError };

export type VerifyMagicLinkResult =
  | { ok: true; data: { userId: string; metadata?: string | null } }
  | { ok: false; error: MagicLinkError };

/**
 * Create a magic link token for passwordless authentication.
 *
 * Given an email for an existing user, generates a ps_magic_* token with the
 * configured expiry. Given a suspended user, returns USER_SUSPENDED. Given an
 * email with no matching user, returns NO_ACCOUNT_FOUND — magic-links are
 * an existing-account login mechanism only. Account creation now happens
 * exclusively through the explicit /auth/signup flow with affirmative ToS
 * acceptance (GDPR + zero-trust requirement). Drive invites no longer issue
 * magic-links; they live in pending_invites and are accepted via the
 * /invite/[token]/accept gateway.
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

  const { email, platform, deviceId, deviceName, expiryMinutes } = parsed.data;
  const normalizedEmail = email.toLowerCase().trim();
  const effectiveExpiryMinutes = expiryMinutes ?? MAGIC_LINK_EXPIRY_MINUTES;

  // Check if user exists
  const existingUser = await db.query.users.findFirst({
    where: eq(users.email, normalizedEmail),
    columns: { id: true, suspendedAt: true },
  });

  if (!existingUser) {
    return { ok: false, error: { code: 'NO_ACCOUNT_FOUND' } };
  }

  // If user is suspended, reject
  if (existingUser.suspendedAt) {
    return {
      ok: false,
      error: { code: 'USER_SUSPENDED', userId: existingUser.id },
    };
  }

  const userId = existingUser.id;

  // Review H1: do NOT delete prior unused magic_link tokens here. The blind
  // type-wide cleanup invalidated multi-token scenarios — a 7-day drive
  // invitation could be silently nuked by a 5-min sign-in (or by an invitation
  // from a second drive, or by Resend on the same drive). Tokens carry their
  // own TTL via expiresAt and a unique tokenHash; verifyMagicLinkToken refuses
  // expired/used rows. Stale entries age out naturally.
  const { token, hash, tokenPrefix } = generateToken('ps_magic');
  const expiresAt = new Date(Date.now() + effectiveExpiryMinutes * 60 * 1000);

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
    data: { token, userId },
  };
}

/**
 * Verify a magic link token and return user info.
 *
 * Given a valid token, returns the userId.
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

  return {
    ok: true,
    data: { userId: record.userId, metadata: record.metadata },
  };
}

import { db } from '@pagespace/db/db';
import { eq, and, isNull } from '@pagespace/db/operators';
import { verificationTokens, users } from '@pagespace/db/schema/auth';
import { createId } from '@paralleldrive/cuid2';
import { randomBytes } from 'crypto';
import { hashToken, getTokenPrefix } from './token-utils';
import { userEmailMatch } from './user-repository';

export type VerificationType = 'email_verification' | 'magic_link' | 'webauthn_signup';

interface CreateTokenOptions {
  userId: string;
  type: VerificationType;
  expiresInMinutes?: number;
  /**
   * For `email_verification` tokens, the address this token authorizes. Stored
   * in metadata so the verify step can confirm the user's email is unchanged
   * before marking it verified — otherwise an in-flight email change could
   * redirect a token sent to a controlled inbox onto a different address.
   */
  email?: string;
}

export async function createVerificationToken(options: CreateTokenOptions): Promise<string> {
  const { userId, type, expiresInMinutes = 1440, email } = options;

  // Generate cryptographically secure token
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000);

  // Clean up old unused tokens for this user and type
  await db
    .delete(verificationTokens)
    .where(
      and(
        eq(verificationTokens.userId, userId),
        eq(verificationTokens.type, type),
        isNull(verificationTokens.usedAt)
      )
    );

  // Hash the token before storing
  const tokenHashValue = hashToken(token);

  // Create new token
  await db.insert(verificationTokens).values({
    id: createId(),
    userId,
    tokenHash: tokenHashValue,
    tokenPrefix: getTokenPrefix(token),
    type,
    expiresAt,
    metadata: email ? JSON.stringify({ email: email.toLowerCase() }) : null,
  });

  return token;  // Return plaintext to caller (goes in email link)
}

export interface VerifiedToken {
  userId: string;
  /** Raw JSON metadata stored with the token, if any (e.g. the bound email). */
  metadata: string | null;
}

export async function verifyToken(
  token: string,
  expectedType: VerificationType
): Promise<VerifiedToken | null> {
  // SECURITY: Hash-only lookup - plaintext tokens are never stored
  const tokenHashValue = hashToken(token);

  // Look up by hash only - no plaintext fallback
  const record = await db.query.verificationTokens.findFirst({
    where: eq(verificationTokens.tokenHash, tokenHashValue),
  });

  if (!record) {
    return null; // Token not found
  }

  // Check if token has been used
  if (record.usedAt) {
    return null; // Token already used
  }

  // Check if token has expired
  if (record.expiresAt < new Date()) {
    return null; // Token expired
  }

  // Check token type matches
  if (record.type !== expectedType) {
    return null; // Wrong token type
  }

  // Atomically claim the token: only the first caller flips usedAt from null,
  // closing the check-then-act race where two requests both pass the usedAt
  // guard above before either writes.
  const claimed = await db
    .update(verificationTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(verificationTokens.id, record.id), isNull(verificationTokens.usedAt)))
    .returning({ id: verificationTokens.id });

  if (claimed.length === 0) {
    return null; // Lost the race — another request already consumed it
  }

  return { userId: record.userId, metadata: record.metadata };
}

export async function markEmailVerified(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ emailVerified: new Date() })
    .where(eq(users.id, userId));
}

/**
 * Verify a specific address: marks `emailVerified` only when the user's CURRENT
 * email still equals `email`. The match-and-write is a single atomic UPDATE so
 * an email change racing with verification cannot verify the wrong address.
 * Returns true when a row was updated (the address still matched).
 */
export async function markEmailVerifiedForAddress(
  userId: string,
  email: string
): Promise<boolean> {
  const updated = await db
    .update(users)
    .set({ emailVerified: new Date() })
    .where(and(eq(users.id, userId), userEmailMatch(email.toLowerCase())))
    .returning({ id: users.id });

  return updated.length > 0;
}

export async function isEmailVerified(userId: string): Promise<boolean> {
  const [user] = await db
    .select({ emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user?.emailVerified !== null && user?.emailVerified !== undefined;
}

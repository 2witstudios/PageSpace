import { db, verificationTokens, users, eq, and, isNull } from '@pagespace/db';
import { createId } from '@paralleldrive/cuid2';
import { randomBytes } from 'crypto';
import { hashToken, getTokenPrefix } from './token-utils';

export type VerificationType = 'email_verification' | 'password_reset' | 'magic_link';

interface CreateTokenOptions {
  userId: string;
  type: VerificationType;
  expiresInMinutes?: number;
}

export async function createVerificationToken(options: CreateTokenOptions): Promise<string> {
  const { userId, type, expiresInMinutes = type === 'password_reset' ? 60 : 1440 } = options;

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

  // SECURITY: Hash the token before storing - never store plaintext
  const tokenHashValue = hashToken(token);

  // Create new token
  await db.insert(verificationTokens).values({
    id: createId(),
    userId,
    token: tokenHashValue,        // Store hash, NOT plaintext
    tokenHash: tokenHashValue,
    tokenPrefix: getTokenPrefix(token),
    type,
    expiresAt,
  });

  return token;  // Return plaintext to caller (goes in email link)
}

export async function verifyToken(token: string, expectedType: VerificationType): Promise<string | null> {
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

  // Mark token as used
  await db
    .update(verificationTokens)
    .set({ usedAt: new Date() })
    .where(eq(verificationTokens.id, record.id));

  return record.userId;
}

export async function markEmailVerified(userId: string): Promise<void> {
  await db
    .update(users)
    .set({ emailVerified: new Date() })
    .where(eq(users.id, userId));
}

export async function isEmailVerified(userId: string): Promise<boolean> {
  const [user] = await db
    .select({ emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user?.emailVerified !== null && user?.emailVerified !== undefined;
}

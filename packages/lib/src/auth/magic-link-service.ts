/**
 * Magic Link Service
 *
 * Verify-side primitive for the magic-link flow. Token issuance lives in
 * the requestMagicLink pipe at @pagespace/lib/services/invites; this module
 * is the timing-safe verifier the GET callback hits when the user clicks
 * the link.
 *
 * @module @pagespace/lib/auth/magic-link-service
 */

import { z } from 'zod';
import { db } from '@pagespace/db/db';
import { eq, and, isNull } from '@pagespace/db/operators';
import { verificationTokens } from '@pagespace/db/schema/auth';
import { hashToken } from './token-utils';
import { secureCompare } from './secure-compare';

// Token expiry: 5 minutes for magic links
export const MAGIC_LINK_EXPIRY_MINUTES = 5;

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

export type MagicLinkError =
  | { code: 'VALIDATION_FAILED'; message: string }
  | { code: 'TOKEN_EXPIRED' }
  | { code: 'TOKEN_ALREADY_USED' }
  | { code: 'TOKEN_NOT_FOUND' }
  | { code: 'USER_SUSPENDED'; userId: string };

export type VerifyMagicLinkResult =
  | { ok: true; data: { userId: string; isNewUser: boolean; metadata?: string | null } }
  | { ok: false; error: MagicLinkError };

/**
 * Verify a magic link token and return user info.
 *
 * Timing-safe hash comparison; rejects expired/used/wrong-type rows; marks
 * the token used atomically with WHERE usedAt IS NULL to defeat TOCTOU
 * concurrent verifies.
 */
export async function verifyMagicLinkToken(input: unknown): Promise<VerifyMagicLinkResult> {
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
  const tokenHash = hashToken(token);

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

  if (record.type !== 'magic_link') {
    return { ok: false, error: { code: 'TOKEN_NOT_FOUND' } };
  }

  if (record.usedAt) {
    return { ok: false, error: { code: 'TOKEN_ALREADY_USED' } };
  }

  if (record.expiresAt < new Date()) {
    return { ok: false, error: { code: 'TOKEN_EXPIRED' } };
  }

  if (!record.user) {
    return { ok: false, error: { code: 'TOKEN_NOT_FOUND' } };
  }

  if (record.user.suspendedAt) {
    return { ok: false, error: { code: 'USER_SUSPENDED', userId: record.userId } };
  }

  const storedHash = record.tokenHash;
  if (!secureCompare(tokenHash, storedHash)) {
    return { ok: false, error: { code: 'TOKEN_NOT_FOUND' } };
  }

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

  if (updateResult.length === 0) {
    return { ok: false, error: { code: 'TOKEN_ALREADY_USED' } };
  }

  const isNewUser = record.user.emailVerified === null;

  return {
    ok: true,
    data: { userId: record.userId, isNewUser, metadata: record.metadata },
  };
}

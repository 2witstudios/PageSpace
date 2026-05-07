import { createId } from '@paralleldrive/cuid2';
import React from 'react';
import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { users, verificationTokens } from '@pagespace/db/schema/auth';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { sendEmail } from '@pagespace/lib/services/email-service';
import { MagicLinkEmail } from '@pagespace/lib/email-templates/MagicLinkEmail';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type { MagicLinkPorts } from '@pagespace/lib/services/invites';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

export const buildMagicLinkPorts = (): MagicLinkPorts => ({
  loadUserByEmail: async ({ email }) =>
    driveInviteRepository.loadUserAccountByEmail(email),

  createUserAccount: async ({ email, tosAcceptedAt }) => {
    const id = createId();
    try {
      const [created] = await db
        .insert(users)
        .values({
          id,
          name: email.split('@')[0] ?? 'New User',
          email,
          provider: 'email',
          role: 'user',
          tokenVersion: 1,
          tosAcceptedAt,
        })
        .returning({ id: users.id });
      return { id: created.id };
    } catch (error: unknown) {
      // Concurrent magic-link request for the same email won the insert race.
      // Re-load and return the surviving id. The losing pipe path still mints
      // a token + sends an email, which is correct — the email is what we
      // wanted to send anyway.
      const isConstraintViolation =
        error instanceof Error &&
        (error.message.includes('unique constraint') ||
          error.message.includes('duplicate key') ||
          error.message.includes('UNIQUE constraint'));
      if (!isConstraintViolation) throw error;

      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));
      if (!existing) throw error;
      return { id: existing.id };
    }
  },

  createTokenAndPersist: async ({ userId, expiresAt, platform, deviceId, deviceName }) => {
    const { token, hash, tokenPrefix } = generateToken('ps_magic');
    const metadata =
      platform === 'desktop' && deviceId
        ? JSON.stringify({ platform, deviceId, deviceName })
        : undefined;
    await db.insert(verificationTokens).values({
      id: createId(),
      userId,
      tokenHash: hash,
      tokenPrefix,
      type: 'magic_link',
      expiresAt,
      ...(metadata && { metadata }),
    });
    return { token };
  },

  sendMagicLinkEmail: async ({ email, token, next }) => {
    try {
      const baseUrl =
        process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const nextSuffix = next ? `&next=${encodeURIComponent(next)}` : '';
      const magicLinkUrl = `${baseUrl}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}${nextSuffix}`;
      await sendEmail({
        to: email,
        subject: 'Sign in to PageSpace',
        react: React.createElement(MagicLinkEmail, { magicLinkUrl }),
      });
    } catch (error) {
      loggers.auth.warn('Failed to send magic link email', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
});

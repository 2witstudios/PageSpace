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

export const buildMagicLinkPorts = (): MagicLinkPorts => ({
  loadUserByEmail: async ({ email }) => {
    const u = await db.query.users.findFirst({
      where: eq(users.email, email.trim().toLowerCase()),
      columns: { id: true, suspendedAt: true },
    });
    return u ? { id: u.id, suspendedAt: u.suspendedAt } : null;
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

  sendMagicLinkEmail: async ({ email, token }) => {
    try {
      const baseUrl =
        process.env.WEB_APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const magicLinkUrl = `${baseUrl}/api/auth/magic-link/verify?token=${token}`;
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

import { createId } from '@paralleldrive/cuid2';
import React from 'react';
import { db } from '@pagespace/db/db';
import { users, verificationTokens } from '@pagespace/db/schema/auth';
import { generateToken } from '@pagespace/lib/auth/token-utils';
import { userEmailMatch, prepareUserWrite } from '@pagespace/lib/auth/user-repository';
import { sendEmail, resolveAppUrl } from '@pagespace/lib/services/email-service';
import { MagicLinkEmail } from '@pagespace/lib/email-templates/MagicLinkEmail';
import { loggers } from '@pagespace/lib/logging/logger-config';
import type { MagicLinkPorts } from '@pagespace/lib/services/invites';
import { driveInviteRepository } from '@/lib/repositories/drive-invite-repository';

// Postgres SQLSTATE 23505 (unique_violation).
const isUniqueConstraintError = (err: unknown): boolean =>
  err instanceof Error && 'code' in err && (err as { code: string }).code === '23505';

export const buildMagicLinkPorts = (): MagicLinkPorts => ({
  loadUserByEmail: async ({ email }) =>
    driveInviteRepository.loadUserAccountByEmail(email),

  createUserAccount: async ({ email, tosAcceptedAt }) => {
    const id = createId();
    try {
      // `name` is NOT NULL in the schema. Email zod-validates upstream so the
      // local part is normally non-empty, but an empty local part would split
      // to '' and `??` only catches null/undefined — fall back with `||` so a
      // pathological email never produces a NOT NULL violation.
      const localPart = email.split('@')[0];
      const newUser: typeof users.$inferInsert = {
        id,
        name: localPart || 'New User',
        email,
        provider: 'email',
        role: 'user',
        tokenVersion: 1,
        tosAcceptedAt,
      };
      const [created] = await db
        .insert(users)
        .values(await prepareUserWrite(newUser))
        .returning({ id: users.id });
      return { id: created.id };
    } catch (error: unknown) {
      // Concurrent magic-link request for the same email won the insert race;
      // re-load and return the surviving id. The losing pipe path still mints
      // a token + sends an email, which is correct — the email is what we
      // wanted to send anyway.
      if (!isUniqueConstraintError(error)) throw error;

      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(userEmailMatch(email));
      if (!existing) throw error;
      return { id: existing.id };
    }
  },

  createTokenAndPersist: async ({
    userId,
    expiresAt,
    platform,
    deviceId,
    deviceName,
    inviteToken,
  }) => {
    const { token, hash, tokenPrefix } = generateToken('ps_magic');
    const metadataObj: Record<string, unknown> = {};
    const boundDevice = boundDevicePlatform(platform, deviceId);
    if (boundDevice) {
      metadataObj.platform = boundDevice;
      // Non-null whenever boundDevice is — that is what the predicate decides.
      metadataObj.deviceId = deviceId;
      if (deviceName) metadataObj.deviceName = deviceName;
    }
    if (inviteToken) {
      metadataObj.inviteToken = inviteToken;
    }
    const metadata = Object.keys(metadataObj).length > 0 ? JSON.stringify(metadataObj) : undefined;
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

  sendMagicLinkEmail: async ({ email, token, next, platform, deviceId }) => {
    try {
      const magicLinkUrl = buildMagicLinkUrl({ token, next, platform, deviceId });
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

/** Path prefix of the in-app magic-link page; must match the AASA and resolver. */
const MAGIC_LINK_APP_PATH = '/auth/magic-link';

/**
 * Which device-bound platform this link belongs to, or `null` for an ordinary
 * browser link.
 *
 * One predicate, because two callers ask the same question and must not drift:
 * the token metadata records the binding, and the emailed URL has to match it.
 * A universal link with no binding behind it would open the app and then fail
 * to sign it in — the original bug, silently restored.
 */
function boundDevicePlatform(
  platform: 'web' | 'desktop' | 'ios' | 'android' | undefined,
  deviceId: string | undefined,
): 'desktop' | 'ios' | 'android' | null {
  if (!deviceId || platform === undefined || platform === 'web') return null;
  return platform;
}

/**
 * The URL the email carries.
 *
 * A link requested from the iOS / Android shell is a universal link
 * (`/auth/magic-link/<token>`, claimed in the AASA and routed by
 * `apps/web/src/lib/navigation/deep-links.ts`) so the tap lands in the app,
 * whose page redeems the token into the Keychain. Everything else keeps the
 * plain verify endpoint: that path is deliberately NOT claimed, so a link
 * requested from Safari on an iPhone stays in Safari where its cookie works.
 */
function buildMagicLinkUrl({
  token,
  next,
  platform,
  deviceId,
}: {
  token: string;
  next?: string;
  platform?: 'web' | 'desktop' | 'ios' | 'android';
  deviceId?: string;
}): string {
  const base = resolveAppUrl();
  const encodedToken = encodeURIComponent(token);
  const boundDevice = boundDevicePlatform(platform, deviceId);
  if (boundDevice === 'ios' || boundDevice === 'android') {
    const nextSuffix = next ? `?next=${encodeURIComponent(next)}` : '';
    return `${base}${MAGIC_LINK_APP_PATH}/${encodedToken}${nextSuffix}`;
  }
  const nextSuffix = next ? `&next=${encodeURIComponent(next)}` : '';
  return `${base}/api/auth/magic-link/verify?token=${encodedToken}${nextSuffix}`;
}

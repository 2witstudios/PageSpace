/**
 * Drive-invite token primitive.
 *
 * Mints opaque `ps_invite_*` tokens for the consent-screen + accept flow.
 * The raw token lives in the recipient's email URL and the page-load
 * handler; only the SHA3-256 hash is persisted (`pendingInvites.tokenHash`).
 *
 * @module @pagespace/lib/auth/invite-token
 */

import { generateToken, hashToken } from './token-utils';
import { secureCompare } from './secure-compare';

export interface CreatedInviteToken {
  token: string;
  tokenHash: string;
  expiresAt: Date | null;
}

export const createInviteToken = ({
  now,
  expiryMinutes = null,
}: {
  now: Date;
  expiryMinutes?: number | null;
}): CreatedInviteToken => {
  const { token, hash } = generateToken('ps_invite');
  const expiresAt = expiryMinutes !== null
    ? new Date(now.getTime() + expiryMinutes * 60 * 1000)
    : null;
  return { token, tokenHash: hash, expiresAt };
};

export const verifyInviteToken = ({
  token,
  tokenHash,
}: {
  token: string;
  tokenHash: string;
}): boolean => secureCompare(hashToken(token), tokenHash);

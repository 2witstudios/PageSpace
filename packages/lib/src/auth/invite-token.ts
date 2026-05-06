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

const DEFAULT_EXPIRY_MINUTES = 60 * 48;

export interface CreatedInviteToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

export const createInviteToken = ({
  now,
  expiryMinutes = DEFAULT_EXPIRY_MINUTES,
}: {
  now: Date;
  expiryMinutes?: number;
}): CreatedInviteToken => {
  const { token, hash } = generateToken('ps_invite');
  const expiresAt = new Date(now.getTime() + expiryMinutes * 60 * 1000);
  return { token, tokenHash: hash, expiresAt };
};

export const verifyInviteToken = ({
  token,
  tokenHash,
}: {
  token: string;
  tokenHash: string;
}): boolean => secureCompare(hashToken(token), tokenHash);

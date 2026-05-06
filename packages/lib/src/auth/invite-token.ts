/**
 * Drive-invite token primitive.
 *
 * Invite tokens are page-load credentials only — they let the recipient land
 * on the consent screen and identify which pending invite is being acted on.
 * They have ZERO authentication power: no session is mintable from a token
 * alone. Sessions only flow from /auth/signup and /auth/login. This separation
 * is deliberate and the reason invites are no longer issued through the
 * magic-link primitive.
 *
 * Tokens are SHA3-256-hashed at rest via the existing project helper, so the
 * raw token never persists in the database, in logs, or in event payloads.
 *
 * @module @pagespace/lib/auth/invite-token
 */

import { generateToken, hashToken } from './token-utils';
import { secureCompare } from './secure-compare';

const INVITE_TOKEN_PREFIX = 'ps_invite';

export const DEFAULT_INVITE_EXPIRY_MINUTES = 48 * 60;

export interface CreatedInviteToken {
  /** Raw token value — embed in the URL ONCE; never persist or log. */
  token: string;
  /** SHA3-256 hex hash — store in `pending_invites.tokenHash`. */
  tokenHash: string;
  /** Absolute expiry timestamp — store in `pending_invites.expiresAt`. */
  expiresAt: Date;
}

export const createInviteToken = ({
  now,
  expiryMinutes = DEFAULT_INVITE_EXPIRY_MINUTES,
}: {
  now: Date;
  expiryMinutes?: number;
}): CreatedInviteToken => {
  const { token, hash } = generateToken(INVITE_TOKEN_PREFIX);
  const expiresAt = new Date(now.getTime() + expiryMinutes * 60 * 1000);
  return { token, tokenHash: hash, expiresAt };
};

export const verifyInviteToken = ({
  token,
  tokenHash,
}: {
  token: string;
  tokenHash: string;
}): boolean => {
  if (token.length === 0 || tokenHash.length === 0) return false;
  return secureCompare(hashToken(token), tokenHash);
};

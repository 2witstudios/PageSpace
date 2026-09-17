/**
 * OAuth account-match decision (security-critical, pure).
 *
 * Closes audit finding M5 (pre-account takeover via an unverified OAuth email):
 * an OAuth token whose email matches an existing magic-link / passkey account
 * must NOT authenticate as that account unless the provider asserts the email is
 * verified. The provider subject id (googleId / appleId) is the strong,
 * cryptographically-bound identity carried in the signed token, so a subject
 * match may always authenticate that account.
 *
 * This single decision is shared by every OAuth account-matching surface
 * (Google one-tap / native / callback, Apple callback / native, mobile exchange)
 * so the rule cannot drift between flows.
 */

import { notAgentReservedEmail } from './agent/reserved-email';

export type OAuthMatchDecision = 'use-sub' | 'use-email' | 'create-new' | 'reject';

export interface ResolveOAuthMatchInput {
  /** An existing account matches the provider subject id (googleId / appleId). */
  providerSubMatch: boolean;
  /** An existing account matches the token's raw email address. */
  emailMatch: boolean;
  /**
   * The provider's verification claim for the email
   * (Google `email_verified` / Apple `email_verified`).
   */
  emailVerified: boolean;
  /** The token's raw email address. */
  email: string;
}

/**
 * Resolve how an OAuth sign-in should be reconciled against existing accounts.
 *
 * - `use-sub`     authenticate the account matched by provider subject id.
 * - `use-email`   link to / authenticate the account matched by (verified) email.
 * - `create-new`  no account matches the subject id or the email — fresh signup.
 * - `reject`      an unverified email collides with an existing account — refuse
 *                 to authenticate (the takeover guard). `email` is unique in the
 *                 schema, so this collision cannot be resolved by creating a new
 *                 account; the caller must deny the sign-in.
 */
export function resolveOAuthMatch({
  providerSubMatch,
  emailMatch,
  emailVerified,
  email,
}: ResolveOAuthMatchInput): OAuthMatchDecision {
  // An agent's synthetic address (ADR 0007 §4) can never enter a human OAuth
  // flow — not to sign in, link, or create a look-alike row. A provider cannot
  // legitimately assert a `.invalid` address, so this is always an attack or a
  // bug, and `reject` is the ordinary denial every route already maps.
  if (!notAgentReservedEmail(email)) {
    return 'reject';
  }

  // Strong identity: a provider-subject match authenticates that account
  // regardless of the email_verified claim. The subject id is bound to the
  // signed token and cannot be spoofed onto a victim's account.
  if (providerSubMatch) {
    return 'use-sub';
  }

  // No subject match. Linking to an EXISTING account by raw email is only safe
  // when the provider asserts the email is verified. An unverified email that
  // happens to match a victim's account is exactly the takeover vector — refuse.
  if (emailMatch) {
    return emailVerified ? 'use-email' : 'reject';
  }

  // No account matches the subject id or the email → fresh signup. Because email
  // is unique in the schema, create-new only occurs when there is no collision.
  return 'create-new';
}

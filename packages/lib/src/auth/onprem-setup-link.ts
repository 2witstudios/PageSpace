import { createId } from '@paralleldrive/cuid2';
import { db } from '@pagespace/db/db';
import { verificationTokens } from '@pagespace/db/schema/auth';
import { generateToken } from './token-utils';

/** Setup links stay valid for 60 minutes — long enough to hand off out-of-band. */
const SETUP_LINK_EXPIRY_MINUTES = 60;

/**
 * Mint a one-time sign-in ("setup") link for on-prem onboarding.
 *
 * On-prem deployments disable outbound email (see {@link import('../services/email-service')}),
 * so admin-created users can't receive a magic-link email and have no passkey yet. This produces a
 * magic-link **verify** URL that works fully offline — only the magic-link *send* route needs email.
 * An operator hands the link to the user out-of-band; on first sign-in the user is funnelled to
 * passkey enrollment (`/auth/passkey-setup`).
 *
 * Used by both `scripts/setup-onprem-admin.ts` (CLI bootstrap) and the admin user-creation route so
 * the token type, TTL, and URL shape stay in one place.
 *
 * The token MUST be minted the same way the real magic-link send flow mints it
 * (`generateToken('ps_magic')` persisted to `verificationTokens` with `type: 'magic_link'`): the
 * verify route's schema rejects any token that does not start with `ps_magic_`, so a bare
 * `createVerificationToken` hex token would always redirect with `invalid_token`. See
 * `magic-link-service.verifyMagicLinkToken` and the `createTokenAndPersist` adapter.
 *
 * The link points at the **web app** (where `/api/auth/magic-link/verify` lives), not the admin app,
 * so the base URL prefers the web app env vars.
 */
export async function generateOnPremSetupLink(userId: string): Promise<string> {
  const { token, hash, tokenPrefix } = generateToken('ps_magic');
  const expiresAt = new Date(Date.now() + SETUP_LINK_EXPIRY_MINUTES * 60 * 1000);

  await db.insert(verificationTokens).values({
    id: createId(),
    userId,
    tokenHash: hash,
    tokenPrefix,
    type: 'magic_link',
    expiresAt,
  });

  const baseUrl =
    process.env.WEB_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    'http://localhost:3000';
  return `${baseUrl.replace(/\/$/, '')}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`;
}

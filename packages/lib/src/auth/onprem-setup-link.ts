import { createVerificationToken } from './verification-utils';

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
 * The link points at the **web app** (where `/api/auth/magic-link/verify` lives), not the admin app,
 * so the base URL prefers the web app env vars.
 */
export async function generateOnPremSetupLink(userId: string): Promise<string> {
  const token = await createVerificationToken({
    userId,
    type: 'magic_link',
    expiresInMinutes: 60,
  });
  const baseUrl =
    process.env.WEB_APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXTAUTH_URL ||
    'http://localhost:3000';
  return `${baseUrl.replace(/\/$/, '')}/api/auth/magic-link/verify?token=${token}`;
}

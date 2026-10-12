/** Server-verified ceremony evidence, carried unchanged by derived credentials. */
export interface VerifiedAuthentication {
  readonly authenticatedAtMs: number;
  readonly assurance: 'single_factor' | 'user_verified_passkey';
}

/**
 * A server-verified sign-in ceremony. D-OW-45: PageSpace has no TOTP, so "two-step" (strong) sign-in is a passkey the
 * authenticator user-verified; every other ceremony (an emailed link, Google, Apple, a passkey without user
 * verification) is one factor.
 */
export type SignInCeremony =
  | { readonly method: 'magic_link' }
  | { readonly method: 'google' }
  | { readonly method: 'apple' }
  | { readonly method: 'passkey'; readonly userVerified: boolean };

/** The evidence a ceremony that the server just verified records on the credential it mints. */
export function ceremonyAuthentication(ceremony: SignInCeremony, nowMs: number): VerifiedAuthentication {
  const strong = ceremony.method === 'passkey' && ceremony.userVerified === true;
  return { authenticatedAtMs: nowMs, assurance: strong ? 'user_verified_passkey' : 'single_factor' };
}

/**
 * The evidence of a machine credential that no person signed in for: system service tokens and drive-env bridge
 * tokens. Named, so a session minted without a ceremony says so at its call site (D-OW-45); org sign-in policies
 * refuse it like any missing evidence.
 */
export const MACHINE_CREDENTIAL_AUTHENTICATION = null;

/** Missing or corrupt evidence never acquires assurance from token creation time. */
export function parseVerifiedAuthentication(raw: unknown, nowMs: number): VerifiedAuthentication | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const { authenticatedAtMs, assurance } = value;
  if (typeof authenticatedAtMs !== 'number' || !Number.isSafeInteger(authenticatedAtMs) || authenticatedAtMs < 0 ||
    !Number.isSafeInteger(nowMs) || authenticatedAtMs > nowMs ||
    (assurance !== 'single_factor' && assurance !== 'user_verified_passkey')) return null;
  return { authenticatedAtMs, assurance };
}

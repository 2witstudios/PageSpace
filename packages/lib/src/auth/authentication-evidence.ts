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

/**
 * How far in the future a ceremony time may read and still count, as clock skew. The time is stamped by whichever
 * process verified the ceremony (web) and read by another (realtime, processor, another web instance, or the database
 * round-trip) whose clock may run a little behind: without a tolerance a credential minted a few milliseconds "in the
 * future" reads as no evidence and is refused right after sign-in. Two minutes covers NTP-disciplined hosts with a wide
 * margin while staying far below the shortest maximum age (15 minutes), so it can never stretch a session's life in any
 * meaningful way; a time beyond it is a forgery or a broken clock and still fails closed. Fixed, not configurable.
 */
export const EVIDENCE_FUTURE_SKEW_MS = 120_000;

/**
 * Missing or corrupt evidence never acquires assurance from token creation time. A ceremony time within
 * EVIDENCE_FUTURE_SKEW_MS of the future is clamped to now (it can only make the credential look younger by that skew);
 * anything further ahead is refused.
 */
export function parseVerifiedAuthentication(raw: unknown, nowMs: number): VerifiedAuthentication | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const { authenticatedAtMs, assurance } = value;
  if (typeof authenticatedAtMs !== 'number' || !Number.isSafeInteger(authenticatedAtMs) || authenticatedAtMs < 0 ||
    !Number.isSafeInteger(nowMs) || authenticatedAtMs > nowMs + EVIDENCE_FUTURE_SKEW_MS ||
    (assurance !== 'single_factor' && assurance !== 'user_verified_passkey')) return null;
  return { authenticatedAtMs: Math.min(authenticatedAtMs, nowMs), assurance };
}

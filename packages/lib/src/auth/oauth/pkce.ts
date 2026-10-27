/**
 * Provider-side PKCE (RFC 7636) for the OAuth 2.1 authorization server.
 *
 * Pure and fail-closed by construction: no I/O, no clock, no ambient
 * randomness — every decision is a function of its arguments only.
 *
 * Deliberately NOT an extension of `../pkce.ts`: that module is PageSpace
 * acting as an OAuth *client* to Google/Apple and is fail-open by design (DB
 * down → flow proceeds without PKCE — acceptable there, per ADR 0003 §1.7).
 * The provider side must never degrade: a missing/invalid/mismatched
 * verifier always refuses the grant, never falls back to "no PKCE".
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7636
 * @module @pagespace/lib/auth/oauth/pkce
 */

import { createHash } from 'crypto';
import { secureCompare } from '../secure-compare';

/** RFC 7636 §4.1: code_verifier = 43*128unreserved; unreserved = ALPHA / DIGIT / "-" / "." / "_" / "~" */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

/** OAuth 2.1 forbids `plain`; this is the only method ever accepted. */
const SUPPORTED_METHOD = 'S256';

/**
 * Validate a code_verifier's shape per RFC 7636 §4.1: length 43-128,
 * unreserved charset only. Does not perform any hashing.
 */
export function isValidCodeVerifier(verifier: string): boolean {
  return typeof verifier === 'string' && CODE_VERIFIER_PATTERN.test(verifier);
}

/**
 * Derive the S256 code_challenge for a code_verifier:
 * BASE64URL(SHA256(ASCII(verifier))).
 *
 * Pure hash derivation only — callers that accept untrusted verifiers must
 * validate shape first (see {@link verifyPkceChallenge}, which does).
 */
export function deriveCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * Verify a code_verifier against a stored code_challenge for the given
 * code_challenge_method. Total function — never throws, always returns a
 * boolean, fails closed on any malformed or unexpected input.
 *
 * - `method` must be exactly `"S256"`; `"plain"`, any other string, or an
 *   absent/non-string method all return false (OAuth 2.1 forbids `plain`;
 *   there is no fallback method).
 * - `verifier` is shape-validated against RFC 7636 §4.1 before any hashing
 *   occurs, so a malformed verifier is rejected without a hash comparison.
 * - The derived challenge and the stored challenge are compared via
 *   {@link secureCompare} (SHA3-256 both sides, then `timingSafeEqual`) per
 *   project convention for secret-derived string comparisons — never `===`.
 */
export function verifyPkceChallenge(verifier: unknown, challenge: unknown, method: unknown): boolean {
  if (method !== SUPPORTED_METHOD) {
    return false;
  }
  if (typeof verifier !== 'string' || !isValidCodeVerifier(verifier)) {
    return false;
  }
  if (typeof challenge !== 'string' || challenge.length === 0) {
    return false;
  }

  const derivedChallenge = deriveCodeChallenge(verifier);
  return secureCompare(derivedChallenge, challenge);
}

/**
 * Derive a code_verifier from injected randomness (RFC 7636 §4.1 recommends
 * ≥32 octets). Randomness is injected so callers stay pure and testable —
 * this function performs no I/O and reads no ambient CSPRNG state itself.
 *
 * Base64url has no padding and its alphabet (`A-Za-z0-9-_`) is a strict
 * subset of the RFC 7636 unreserved charset, so any output is automatically
 * a valid code_verifier as long as the byte count keeps the encoded length
 * within 43-128 (32 octets encodes to exactly 43 chars).
 */
export function generateCodeVerifier(randomBytes: Uint8Array): string {
  return Buffer.from(randomBytes).toString('base64url');
}

/**
 * Client-side PKCE (RFC 7636) math for the OAuth 2.1 authorization-code +
 * PKCE flow (`pagespace login`, `packages/cli/src/auth/loopback-flow.ts`).
 *
 * Pure: no I/O, no clock, no ambient randomness — every decision is a
 * function of its arguments only. Deliberately copied (not imported) from
 * the provider-side implementation (`packages/lib/src/auth/oauth/pkce.ts`,
 * which also verifies challenges server-side and pulls in
 * `packages/lib`'s `secureCompare`): the published SDK must never
 * runtime-import `@pagespace/lib` (see `operations/roles.ts`'s equivalent
 * inlining of `PagePerm`, for the same reason) — the derivation itself is
 * the same SHA256/base64url math regardless of which side of the exchange
 * calls it.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7636
 */
import { createHash } from 'node:crypto';

/**
 * Derive a code_verifier from injected randomness (RFC 7636 §4.1 recommends
 * ≥32 octets). Randomness is injected so callers stay pure and testable —
 * this function performs no I/O and reads no ambient CSPRNG state itself.
 *
 * Base64url has no padding and its alphabet (`A-Za-z0-9-_`) is a strict
 * subset of RFC 7636's unreserved charset, so any output is automatically a
 * valid code_verifier as long as the byte count keeps the encoded length
 * within 43-128 (32 octets encodes to exactly 43 chars).
 */
export function generateCodeVerifier(randomBytes: Uint8Array): string {
  return Buffer.from(randomBytes).toString('base64url');
}

/**
 * Derive the S256 code_challenge for a code_verifier:
 * BASE64URL(SHA256(ASCII(verifier))).
 */
export function deriveCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

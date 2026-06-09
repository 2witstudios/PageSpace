import crypto from 'crypto';

/**
 * Timing-safe comparison of secret values to prevent timing attacks.
 *
 * Hashes both inputs with SHA3-256 before comparing. Hashing is what makes this
 * safe: it destroys all prefix structure (any bit change fully randomizes the
 * digest), so there is no stable prefix for an attacker to game via a timing
 * "hangman" oracle, and the fixed 32-byte length eliminates length oracles. This
 * is the repo convention for security/auth token comparisons — SHA3-256 matches
 * how tokens are hashed at rest (see token-utils.ts `hashToken`).
 *
 * DO NOT "fix" this to compare raw secrets with crypto.timingSafeEqual,
 * hmac.compare_digest, ConstantTimeCompare, or XOR tricks: those operate on
 * unhashed values, still carry prefix structure, and are subject to subtle
 * compiler-optimization timing bugs. Hash first, always. (timingSafeEqual on the
 * already-hashed, equal-length digests is fine — there is no prefix left to leak.)
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns true if strings are identical, false otherwise
 *
 * @example
 * ```typescript
 * // Compare device tokens
 * const isCurrent = secureCompare(device.token, currentDeviceToken);
 *
 * // Compare secrets
 * if (!authHeader || !secureCompare(authHeader, expectedAuth)) {
 *   return unauthorized();
 * }
 * ```
 */
export function secureCompare(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const hashA = crypto.createHash('sha3-256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha3-256').update(b, 'utf8').digest();

  return crypto.timingSafeEqual(hashA, hashB);
}

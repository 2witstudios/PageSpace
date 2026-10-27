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

  // CodeQL's js/insufficient-password-hash flags these createHash calls. That is
  // a FALSE POSITIVE here (tracked/dismissed for the prior SHA-256 form as alerts
  // #160/#161): this is a deterministic constant-time comparison of HIGH-ENTROPY
  // secrets (API keys, HMAC signatures, opaque device tokens), not at-rest storage
  // of low-entropy user passwords. A slow salted KDF (bcrypt/scrypt/argon2) is
  // inapplicable — it is non-deterministic, so two independently-derived digests
  // could never be compared for equality, and it would only add latency.
  const hashA = crypto.createHash('sha3-256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha3-256').update(b, 'utf8').digest();

  return crypto.timingSafeEqual(hashA, hashB);
}

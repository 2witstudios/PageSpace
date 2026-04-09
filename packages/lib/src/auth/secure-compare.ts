import crypto from 'crypto';

/**
 * Timing-safe comparison of secret values to prevent timing attacks.
 *
 * Hashes both inputs with SHA-256 before comparing with timingSafeEqual.
 * This destroys prefix structure and guarantees equal-length (32-byte)
 * buffers, eliminating timing leaks from length or content differences.
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

  const hashA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hashB = crypto.createHash('sha256').update(b, 'utf8').digest();

  return crypto.timingSafeEqual(hashA, hashB);
}

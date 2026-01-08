import { timingSafeEqual } from 'crypto';

/**
 * Timing-safe comparison of secret values to prevent timing attacks.
 *
 * Uses crypto.timingSafeEqual under the hood. When lengths differ,
 * performs a constant-time comparison against self to avoid leaking
 * length information through timing.
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
  // Handle non-string inputs safely
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');

  // Length check must happen, but we still do the comparison to maintain constant time
  if (bufA.length !== bufB.length) {
    // Compare with self to maintain constant timing
    timingSafeEqual(bufA, bufA);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

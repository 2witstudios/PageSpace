/**
 * Token Utilities (P1-T3)
 *
 * Secure token generation and hashing for refresh tokens and MCP tokens.
 * All sensitive tokens MUST be stored as SHA-256 hashes, never plaintext.
 *
 * @module @pagespace/lib/auth/token-utils
 */

import { createHash, randomBytes } from 'crypto';

/**
 * Token generation result containing the raw token (shown once),
 * its hash (stored in DB), and prefix (for debugging).
 */
export interface GeneratedToken {
  /** Raw token value - show to user ONCE, never store */
  token: string;
  /** SHA-256 hash of token - store in database */
  hash: string;
  /** First 12 characters - store for debugging/identification */
  tokenPrefix: string;
}

/**
 * Hash a token using SHA-256.
 *
 * Used for:
 * - Storing tokens securely in the database
 * - Looking up tokens by computing hash of provided value
 *
 * @param token - The raw token string to hash
 * @returns SHA-256 hex hash (64 characters)
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Extract the token prefix (first 12 characters).
 *
 * The prefix is stored alongside the hash for:
 * - Debugging token issues
 * - Identifying token type from logs
 * - NOT for security (insufficient for lookup)
 *
 * @param token - The raw token string
 * @returns First 12 characters of the token
 */
export function getTokenPrefix(token: string): string {
  return token.substring(0, 12);
}

/**
 * Generate a new cryptographically secure token.
 *
 * Creates a token with:
 * - Custom prefix for identification (e.g., 'ps_refresh', 'mcp')
 * - 32 bytes (256 bits) of cryptographic randomness
 * - Base64URL encoding for URL-safe transmission
 *
 * @param prefix - Token type prefix (e.g., 'ps_refresh', 'mcp', 'ps_device')
 * @returns Object with token, hash, and tokenPrefix
 *
 * @example
 * ```typescript
 * const { token, hash, tokenPrefix } = generateToken('ps_refresh');
 * // token: 'ps_refresh_abc123...' (show to user)
 * // hash: 'a1b2c3...' (store in DB)
 * // tokenPrefix: 'ps_refresh_ab' (store for debugging)
 * ```
 */
export function generateToken(prefix: string): GeneratedToken {
  // 32 bytes = 256 bits of entropy
  const randomPart = randomBytes(32).toString('base64url');
  const token = `${prefix}_${randomPart}`;

  return {
    token,
    hash: hashToken(token),
    tokenPrefix: getTokenPrefix(token),
  };
}

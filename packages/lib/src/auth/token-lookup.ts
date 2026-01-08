/**
 * Token Lookup Utilities (P1-T3)
 *
 * Dual-mode token lookup for migration from plaintext to hash-based storage.
 * During migration:
 * 1. First tries to find token by hash (new tokens)
 * 2. Falls back to plaintext lookup (legacy tokens)
 *
 * After migration is complete, the plaintext fallback can be removed.
 *
 * @module @pagespace/lib/auth/token-lookup
 */

import { db, refreshTokens, mcpTokens, eq, and, isNull, or } from '@pagespace/db';
import { hashToken } from './token-utils';

const MCP_TOKEN_PREFIX = 'mcp_';

/**
 * Refresh token record with user relation
 */
export interface RefreshTokenRecord {
  id: string;
  userId: string;
  token: string;
  tokenHash: string | null;
  tokenPrefix: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  platform: string | null;
  device: string | null;
  ip: string | null;
  userAgent: string | null;
  deviceTokenId: string | null;
  createdAt: Date;
  user: {
    id: string;
    tokenVersion: number;
    role: string;
  };
}

/**
 * MCP token record with user relation
 */
export interface MCPTokenRecord {
  id: string;
  userId: string;
  token: string;
  tokenHash: string | null;
  tokenPrefix: string | null;
  name: string;
  lastUsed: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
  user: {
    id: string;
    tokenVersion: number;
    role: string;
  };
}

/**
 * Find a refresh token by its value using dual-mode lookup.
 *
 * Migration strategy:
 * 1. Compute hash of provided token
 * 2. Try to find by tokenHash (new tokens have this)
 * 3. If not found, fall back to plaintext token column (legacy tokens)
 *
 * @param tokenValue - The raw refresh token value
 * @returns The token record with user relation, or null if not found
 */
export async function findRefreshTokenByValue(
  tokenValue: string
): Promise<RefreshTokenRecord | null> {
  // Guard against empty/invalid input
  if (!tokenValue || typeof tokenValue !== 'string') {
    return null;
  }

  const tokenHash = hashToken(tokenValue);

  // Try hash lookup first (new tokens)
  const byHash = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.tokenHash, tokenHash),
    with: {
      user: {
        columns: {
          id: true,
          tokenVersion: true,
          role: true,
        },
      },
    },
  });

  if (byHash) {
    return byHash as RefreshTokenRecord;
  }

  // Fall back to plaintext lookup (legacy tokens during migration)
  const byPlaintext = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.token, tokenValue),
    with: {
      user: {
        columns: {
          id: true,
          tokenVersion: true,
          role: true,
        },
      },
    },
  });

  return (byPlaintext ?? null) as RefreshTokenRecord | null;
}

/**
 * Find an MCP token by its value using dual-mode lookup.
 *
 * Only searches for non-revoked tokens (revokedAt IS NULL).
 *
 * Migration strategy:
 * 1. Compute hash of provided token
 * 2. Try to find by tokenHash (new tokens have this)
 * 3. If not found, fall back to plaintext token column (legacy tokens)
 *
 * @param tokenValue - The raw MCP token value (must start with 'mcp_')
 * @returns The token record with user relation, or null if not found/revoked
 */
export async function findMCPTokenByValue(
  tokenValue: string
): Promise<MCPTokenRecord | null> {
  // Guard against empty/invalid input
  if (!tokenValue || typeof tokenValue !== 'string') {
    return null;
  }

  // MCP tokens must start with the correct prefix
  if (!tokenValue.startsWith(MCP_TOKEN_PREFIX)) {
    return null;
  }

  const tokenHash = hashToken(tokenValue);

  // Try hash lookup first (new tokens), filtering out revoked
  const byHash = await db.query.mcpTokens.findFirst({
    where: and(
      eq(mcpTokens.tokenHash, tokenHash),
      isNull(mcpTokens.revokedAt)
    ),
    with: {
      user: {
        columns: {
          id: true,
          tokenVersion: true,
          role: true,
        },
      },
    },
  });

  if (byHash) {
    return byHash as MCPTokenRecord;
  }

  // Fall back to plaintext lookup (legacy tokens during migration)
  const byPlaintext = await db.query.mcpTokens.findFirst({
    where: and(
      eq(mcpTokens.token, tokenValue),
      isNull(mcpTokens.revokedAt)
    ),
    with: {
      user: {
        columns: {
          id: true,
          tokenVersion: true,
          role: true,
        },
      },
    },
  });

  return (byPlaintext ?? null) as MCPTokenRecord | null;
}

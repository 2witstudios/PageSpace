/**
 * Token Lookup Utilities (P1-T3)
 *
 * Hash-based token lookup for secure token storage.
 * All tokens are stored as SHA-256 hashes - plaintext tokens are never stored.
 *
 * @module @pagespace/lib/auth/token-lookup
 */

import { db, mcpTokens, eq, and, isNull } from '@pagespace/db';
import { hashToken } from './token-utils';

const MCP_TOKEN_PREFIX = 'mcp_';

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
 * Find an MCP token by its hash value.
 *
 * Security: Only looks up by hash - plaintext tokens are never stored or compared.
 * Only searches for non-revoked tokens (revokedAt IS NULL).
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

  // Look up by hash only, filtering out revoked - no plaintext fallback
  const record = await db.query.mcpTokens.findFirst({
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

  return (record ?? null) as MCPTokenRecord | null;
}

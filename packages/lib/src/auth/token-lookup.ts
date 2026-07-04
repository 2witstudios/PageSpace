/**
 * Token Lookup Utilities (P1-T3)
 *
 * Hash-based token lookup for secure token storage.
 * All tokens are stored as SHA3-256 hashes - plaintext tokens are never stored.
 *
 * @module @pagespace/lib/auth/token-lookup
 */

import { db } from '@pagespace/db/db';
import { eq, and, isNull } from '@pagespace/db/operators';
import { mcpTokens } from '@pagespace/db/schema/auth';
import { oauthAccessTokens } from '@pagespace/db/schema/oauth';
import { hashToken } from './token-utils';

const MCP_TOKEN_PREFIX = 'mcp_';
const OAUTH_ACCESS_TOKEN_PREFIX = 'ps_at_';

/**
 * MCP token record with user relation
 */
export interface MCPTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  tokenPrefix: string;
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

/**
 * OAuth 2.1 access token record with user relation (ADR 0003 §3.1-3.2).
 */
export interface OAuthAccessTokenRecord {
  id: string;
  userId: string;
  scopes: string[];
  tokenVersion: number;
  expiresAt: Date;
  revokedAt: Date | null;
  user: {
    id: string;
    tokenVersion: number;
    role: string;
    adminRoleVersion: number;
    suspendedAt: Date | null;
  };
}

/**
 * Find an OAuth access token by its hash value.
 *
 * Security: Only looks up by hash - plaintext tokens are never stored or
 * compared. Only searches for non-revoked tokens (revokedAt IS NULL); expiry
 * and suspended-user rejection are the caller's job (mirrors findMCPTokenByValue).
 *
 * @param tokenValue - The raw OAuth access token value (must start with 'ps_at_')
 * @returns The token record with user relation, or null if not found/revoked
 */
export async function findOAuthAccessTokenByValue(
  tokenValue: string
): Promise<OAuthAccessTokenRecord | null> {
  if (!tokenValue || typeof tokenValue !== 'string') {
    return null;
  }

  if (!tokenValue.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)) {
    return null;
  }

  const tokenHash = hashToken(tokenValue);

  const record = await db.query.oauthAccessTokens.findFirst({
    where: and(
      eq(oauthAccessTokens.tokenHash, tokenHash),
      isNull(oauthAccessTokens.revokedAt)
    ),
    with: {
      user: {
        columns: {
          id: true,
          tokenVersion: true,
          role: true,
          adminRoleVersion: true,
          suspendedAt: true,
        },
      },
    },
  });

  return (record ?? null) as OAuthAccessTokenRecord | null;
}

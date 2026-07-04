/**
 * @scaffold - ORM query mock present (db.query.mcpTokens.findFirst).
 * Pending token-repository seam extraction for full rubric compliance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@pagespace/db/db', () => ({
  db: {
    query: {
      mcpTokens: { findFirst: vi.fn() },
      oauthAccessTokens: { findFirst: vi.fn() },
    },
  },
}));
vi.mock('@pagespace/db/schema/auth', () => ({
  mcpTokens: {
    tokenHash: 'tokenHash',
    revokedAt: 'revokedAt',
  },
}));
vi.mock('@pagespace/db/schema/oauth', () => ({
  oauthAccessTokens: {
    tokenHash: 'oauthAccessTokens.tokenHash',
    revokedAt: 'oauthAccessTokens.revokedAt',
  },
}));
vi.mock('@pagespace/db/operators', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
}));

import { findMCPTokenByValue, findOAuthAccessTokenByValue } from '../token-lookup';
import { db } from '@pagespace/db/db';

describe('token-lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('findMCPTokenByValue', () => {
    it('should return null for empty input', async () => {
      const result = await findMCPTokenByValue('');
      expect(result).toBeNull();
      expect(db.query.mcpTokens.findFirst).not.toHaveBeenCalled();
    });

    it('should return null for non-string input', async () => {
      const result = await findMCPTokenByValue(null as unknown as string);
      expect(result).toBeNull();
    });

    it('should return null for token without mcp_ prefix', async () => {
      const result = await findMCPTokenByValue('invalid_token_value');
      expect(result).toBeNull();
      expect(db.query.mcpTokens.findFirst).not.toHaveBeenCalled();
    });

    it('should look up token by hash when prefix is correct', async () => {
      const mockRecord = {
        id: 'token-1',
        userId: 'user-1',
        tokenHash: 'hash123',
        tokenPrefix: 'mcp_abc',
        name: 'My Token',
        lastUsed: null,
        createdAt: new Date(),
        revokedAt: null,
        user: { id: 'user-1', tokenVersion: 1, role: 'user' },
      };
      vi.mocked(db.query.mcpTokens.findFirst).mockResolvedValue(mockRecord as never);

      const result = await findMCPTokenByValue('mcp_some-valid-token');
      expect(result).toEqual(mockRecord);
      expect(db.query.mcpTokens.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          with: expect.objectContaining({
            user: expect.objectContaining({
              columns: { id: true, tokenVersion: true, role: true },
            }),
          }),
        })
      );
    });

    it('should return null when no matching token found', async () => {
      vi.mocked(db.query.mcpTokens.findFirst).mockResolvedValue(undefined as never);

      const result = await findMCPTokenByValue('mcp_nonexistent-token');
      expect(result).toBeNull();
    });
  });

  describe('findOAuthAccessTokenByValue', () => {
    it('should return null for empty input', async () => {
      const result = await findOAuthAccessTokenByValue('');
      expect(result).toBeNull();
      expect(db.query.oauthAccessTokens.findFirst).not.toHaveBeenCalled();
    });

    it('should return null for non-string input', async () => {
      const result = await findOAuthAccessTokenByValue(null as unknown as string);
      expect(result).toBeNull();
    });

    it('should return null for token without ps_at_ prefix', async () => {
      const result = await findOAuthAccessTokenByValue('mcp_some-token');
      expect(result).toBeNull();
      expect(db.query.oauthAccessTokens.findFirst).not.toHaveBeenCalled();
    });

    it('should look up token by hash when prefix is correct', async () => {
      const mockRecord = {
        id: 'oauth-token-1',
        userId: 'user-1',
        tokenHash: 'hash123',
        tokenPrefix: 'ps_at_abc',
        familyId: 'family-1',
        scopes: ['account'],
        tokenVersion: 1,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        revokedAt: null,
        user: { id: 'user-1', tokenVersion: 1, role: 'user', adminRoleVersion: 0, suspendedAt: null },
      };
      vi.mocked(db.query.oauthAccessTokens.findFirst).mockResolvedValue(mockRecord as never);

      const result = await findOAuthAccessTokenByValue('ps_at_some-valid-token');
      expect(result).toEqual(mockRecord);
      expect(db.query.oauthAccessTokens.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          with: expect.objectContaining({
            user: expect.objectContaining({
              columns: { id: true, tokenVersion: true, role: true, adminRoleVersion: true, suspendedAt: true },
            }),
          }),
        })
      );
    });

    it('should return null when no matching token found', async () => {
      vi.mocked(db.query.oauthAccessTokens.findFirst).mockResolvedValue(undefined as never);

      const result = await findOAuthAccessTokenByValue('ps_at_nonexistent-token');
      expect(result).toBeNull();
    });
  });
});

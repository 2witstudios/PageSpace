import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hashToken } from '../auth/token-utils';

/**
 * Token Lookup Unit Tests (P1-T3)
 *
 * Validates hash-based token lookup for secure token storage.
 * All tokens are looked up by hash only - no plaintext fallback.
 */

// Mock the database module
vi.mock('@pagespace/db', () => {
  const mockDb = {
    query: {
      refreshTokens: {
        findFirst: vi.fn(),
      },
      mcpTokens: {
        findFirst: vi.fn(),
      },
    },
  };
  return {
    db: mockDb,
    refreshTokens: { tokenHash: 'tokenHash', token: 'token' },
    mcpTokens: { tokenHash: 'tokenHash', token: 'token' },
    eq: vi.fn((field, value) => ({ field, value, op: 'eq' })),
    and: vi.fn((...conditions) => ({ conditions, op: 'and' })),
    isNull: vi.fn((field) => ({ field, op: 'isNull' })),
  };
});

// Import after mocking
import { db } from '@pagespace/db';
import {
  findRefreshTokenByValue,
  findMCPTokenByValue,
} from '../auth/token-lookup';

describe('Token Lookup - Hash Only', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('findRefreshTokenByValue', () => {
    const mockToken = 'ps_refresh_abc123xyz456789012345678901234567890';
    const mockTokenHash = hashToken(mockToken);

    describe('given a token that exists with hash in database', () => {
      it('should find by hash lookup and return the token record', async () => {
        const mockRecord = {
          id: 'token-id-1',
          userId: 'user-id-1',
          tokenHash: mockTokenHash,
          tokenPrefix: 'ps_refresh_ab',
          token: mockToken,
          user: { id: 'user-id-1', tokenVersion: 1, role: 'user' },
          createdAt: new Date(),
          device: null,
          ip: null,
          userAgent: null,
          expiresAt: new Date(),
          lastUsedAt: new Date(),
          platform: 'web' as const,
          deviceTokenId: null,
        };

        vi.mocked(db.query.refreshTokens.findFirst).mockResolvedValue(mockRecord);

        const result = await findRefreshTokenByValue(mockToken);

        expect(result).toEqual(mockRecord);
        expect(db.query.refreshTokens.findFirst).toHaveBeenCalledTimes(1);
      });
    });

    describe('given a non-existent token', () => {
      it('should return null after hash lookup fails', async () => {
        vi.mocked(db.query.refreshTokens.findFirst).mockResolvedValue(undefined);

        const result = await findRefreshTokenByValue('nonexistent_token');

        expect(result).toBeNull();
        expect(db.query.refreshTokens.findFirst).toHaveBeenCalledTimes(1);
      });
    });

    describe('given an empty token', () => {
      it('should return null without database queries', async () => {
        const result = await findRefreshTokenByValue('');

        expect(result).toBeNull();
        expect(db.query.refreshTokens.findFirst).not.toHaveBeenCalled();
      });
    });

    describe('given undefined token', () => {
      it('should return null without database queries', async () => {
        const result = await findRefreshTokenByValue(undefined as unknown as string);

        expect(result).toBeNull();
        expect(db.query.refreshTokens.findFirst).not.toHaveBeenCalled();
      });
    });

    describe('given a legacy token without hash (migration complete)', () => {
      it('should return null - no plaintext fallback', async () => {
        const legacyToken = 'legacy_token_without_hash';

        // Hash lookup returns nothing - no fallback to plaintext
        vi.mocked(db.query.refreshTokens.findFirst).mockResolvedValue(undefined);

        const result = await findRefreshTokenByValue(legacyToken);

        // Legacy tokens are no longer valid - users must re-login
        expect(result).toBeNull();
        expect(db.query.refreshTokens.findFirst).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('findMCPTokenByValue', () => {
    const mockToken = 'mcp_abc123xyz456789012345678901234567890';
    const mockTokenHash = hashToken(mockToken);

    describe('given a token that exists with hash in database', () => {
      it('should find by hash lookup and return the token record', async () => {
        const mockRecord = {
          id: 'mcp-token-id-1',
          userId: 'user-id-1',
          tokenHash: mockTokenHash,
          tokenPrefix: 'mcp_abc123xy',
          token: mockToken,
          name: 'Test MCP Token',
          revokedAt: null,
          createdAt: new Date(),
          lastUsed: new Date(),
        };

        vi.mocked(db.query.mcpTokens.findFirst).mockResolvedValue(mockRecord);

        const result = await findMCPTokenByValue(mockToken);

        expect(result).toEqual(mockRecord);
        expect(db.query.mcpTokens.findFirst).toHaveBeenCalledTimes(1);
      });
    });

    describe('given a revoked token', () => {
      it('should return null (revoked tokens filtered by query)', async () => {
        // The query includes isNull(revokedAt), so revoked tokens won't match
        vi.mocked(db.query.mcpTokens.findFirst).mockResolvedValue(undefined);

        const result = await findMCPTokenByValue('mcp_revoked_token');

        expect(result).toBeNull();
      });
    });

    describe('given a non-existent token', () => {
      it('should return null after hash lookup fails', async () => {
        vi.mocked(db.query.mcpTokens.findFirst).mockResolvedValue(undefined);

        const result = await findMCPTokenByValue('mcp_nonexistent');

        expect(result).toBeNull();
        expect(db.query.mcpTokens.findFirst).toHaveBeenCalledTimes(1);
      });
    });

    describe('given a token without mcp_ prefix', () => {
      it('should return null without database queries', async () => {
        const result = await findMCPTokenByValue('not_an_mcp_token');

        expect(result).toBeNull();
        expect(db.query.mcpTokens.findFirst).not.toHaveBeenCalled();
      });
    });

    describe('given a legacy MCP token without hash (migration complete)', () => {
      it('should return null - no plaintext fallback', async () => {
        const legacyToken = 'mcp_legacy_without_hash';

        // Hash lookup returns nothing - no fallback to plaintext
        vi.mocked(db.query.mcpTokens.findFirst).mockResolvedValue(undefined);

        const result = await findMCPTokenByValue(legacyToken);

        // Legacy tokens are no longer valid - users must regenerate
        expect(result).toBeNull();
        expect(db.query.mcpTokens.findFirst).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('hash computation', () => {
    it('should use consistent SHA-256 hashing', () => {
      const token = 'test_token_123';
      const hash1 = hashToken(token);
      const hash2 = hashToken(token);

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[a-f0-9]{64}$/);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hashToken } from '../auth/token-utils';

/**
 * Token Lookup Unit Tests (P1-T3)
 *
 * Validates dual-mode token lookup for migration from plaintext to hash-based storage.
 * During migration, lookups try hash first, then fall back to plaintext.
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
    or: vi.fn((...conditions) => ({ conditions, op: 'or' })),
  };
});

// Import after mocking
import { db } from '@pagespace/db';
import {
  findRefreshTokenByValue,
  findMCPTokenByValue,
} from '../auth/token-lookup';

describe('Token Lookup - Dual Mode', () => {
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
        };

        vi.mocked(db.query.refreshTokens.findFirst).mockResolvedValue(mockRecord);

        const result = await findRefreshTokenByValue(mockToken);

        expect(result).toEqual(mockRecord);
        expect(db.query.refreshTokens.findFirst).toHaveBeenCalledTimes(1);
      });
    });

    describe('given a legacy token without hash (migration scenario)', () => {
      it('should fall back to plaintext lookup when hash lookup returns null', async () => {
        const legacyToken = 'legacy_token_without_hash';
        const mockRecord = {
          id: 'legacy-token-id',
          userId: 'user-id-2',
          tokenHash: null,
          tokenPrefix: null,
          token: legacyToken,
          user: { id: 'user-id-2', tokenVersion: 1, role: 'user' },
        };

        // First call (hash lookup) returns null
        // Second call (plaintext lookup) returns the record
        vi.mocked(db.query.refreshTokens.findFirst)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(mockRecord);

        const result = await findRefreshTokenByValue(legacyToken);

        expect(result).toEqual(mockRecord);
        expect(db.query.refreshTokens.findFirst).toHaveBeenCalledTimes(2);
      });
    });

    describe('given a non-existent token', () => {
      it('should return null after both lookups fail', async () => {
        vi.mocked(db.query.refreshTokens.findFirst)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null);

        const result = await findRefreshTokenByValue('nonexistent_token');

        expect(result).toBeNull();
        expect(db.query.refreshTokens.findFirst).toHaveBeenCalledTimes(2);
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
          user: { id: 'user-id-1', tokenVersion: 1, role: 'user' },
        };

        vi.mocked(db.query.mcpTokens.findFirst).mockResolvedValue(mockRecord);

        const result = await findMCPTokenByValue(mockToken);

        expect(result).toEqual(mockRecord);
        expect(db.query.mcpTokens.findFirst).toHaveBeenCalledTimes(1);
      });
    });

    describe('given a legacy MCP token without hash', () => {
      it('should fall back to plaintext lookup', async () => {
        const legacyToken = 'mcp_legacy_without_hash';
        const mockRecord = {
          id: 'legacy-mcp-id',
          userId: 'user-id-2',
          tokenHash: null,
          tokenPrefix: null,
          token: legacyToken,
          name: 'Legacy Token',
          revokedAt: null,
          user: { id: 'user-id-2', tokenVersion: 1, role: 'user' },
        };

        vi.mocked(db.query.mcpTokens.findFirst)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(mockRecord);

        const result = await findMCPTokenByValue(legacyToken);

        expect(result).toEqual(mockRecord);
        expect(db.query.mcpTokens.findFirst).toHaveBeenCalledTimes(2);
      });
    });

    describe('given a revoked token', () => {
      it('should return null (revoked tokens filtered by query)', async () => {
        // The query includes isNull(revokedAt), so revoked tokens won't match
        vi.mocked(db.query.mcpTokens.findFirst)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null);

        const result = await findMCPTokenByValue('mcp_revoked_token');

        expect(result).toBeNull();
      });
    });

    describe('given a non-existent token', () => {
      it('should return null after both lookups fail', async () => {
        vi.mocked(db.query.mcpTokens.findFirst)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null);

        const result = await findMCPTokenByValue('mcp_nonexistent');

        expect(result).toBeNull();
        expect(db.query.mcpTokens.findFirst).toHaveBeenCalledTimes(2);
      });
    });

    describe('given a token without mcp_ prefix', () => {
      it('should return null without database queries', async () => {
        const result = await findMCPTokenByValue('not_an_mcp_token');

        expect(result).toBeNull();
        expect(db.query.mcpTokens.findFirst).not.toHaveBeenCalled();
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

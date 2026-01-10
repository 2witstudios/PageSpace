import { describe, it, expect } from 'vitest';
import { hashToken, generateToken, getTokenPrefix } from '../auth/token-utils';

/**
 * Token Utils Unit Tests (P1-T3)
 *
 * Validates token generation and hashing utilities for secure token storage.
 * Tokens must be stored as SHA-256 hashes with a prefix for debugging.
 */
describe('Token Utils', () => {
  describe('hashToken', () => {
    it('given a token string, should return SHA-256 hex hash', () => {
      const token = 'test_abc123xyz';
      const hash = hashToken(token);

      // SHA-256 produces 64 hex characters
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('given the same token twice, should produce identical hashes', () => {
      const token = 'refresh_token_example_123';

      const hash1 = hashToken(token);
      const hash2 = hashToken(token);

      expect(hash1).toBe(hash2);
    });

    it('given different tokens, should produce different hashes', () => {
      const token1 = 'token_aaa111';
      const token2 = 'token_bbb222';

      const hash1 = hashToken(token1);
      const hash2 = hashToken(token2);

      expect(hash1).not.toBe(hash2);
    });

    it('given an empty string, should still produce a valid hash', () => {
      const hash = hashToken('');

      // SHA-256 of empty string is a known value
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('given a very long token (1000+ chars), should produce a valid hash', () => {
      const longToken = 'prefix_' + 'a'.repeat(1000);
      const hash = hashToken(longToken);

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('getTokenPrefix', () => {
    it('given a token, should return first 12 characters', () => {
      const token = 'ps_refresh_abc123xyz456';
      const prefix = getTokenPrefix(token);

      expect(prefix).toBe('ps_refresh_a');
      expect(prefix.length).toBe(12);
    });

    it('given a short token (< 12 chars), should return the full token', () => {
      const token = 'short';
      const prefix = getTokenPrefix(token);

      expect(prefix).toBe('short');
    });

    it('given exactly 12 characters, should return all 12', () => {
      const token = '123456789012';
      const prefix = getTokenPrefix(token);

      expect(prefix).toBe('123456789012');
    });
  });

  describe('generateToken', () => {
    it('given a prefix, should return token object with token, hash, and tokenPrefix', () => {
      const result = generateToken('ps_refresh');

      expect(result).toHaveProperty('token');
      expect(result).toHaveProperty('hash');
      expect(result).toHaveProperty('tokenPrefix');
    });

    it('given a prefix, should generate token starting with that prefix', () => {
      const result = generateToken('ps_mcp');

      expect(result.token).toMatch(/^ps_mcp_/);
    });

    it('should generate unique tokens on each call', () => {
      const result1 = generateToken('ps_refresh');
      const result2 = generateToken('ps_refresh');

      expect(result1.token).not.toBe(result2.token);
      expect(result1.hash).not.toBe(result2.hash);
    });

    it('should generate hash that matches hashToken of the token', () => {
      const result = generateToken('ps_test');

      const expectedHash = hashToken(result.token);

      expect(result.hash).toBe(expectedHash);
    });

    it('should generate tokenPrefix that is first 12 chars of token', () => {
      const result = generateToken('ps_device');

      expect(result.tokenPrefix).toBe(result.token.substring(0, 12));
    });

    it('should generate token with sufficient entropy (32 bytes = 43 base64url chars)', () => {
      const result = generateToken('ps_test');

      // Token format: {prefix}_{randomBase64url}
      // prefix = 'ps_test' (7 chars) + '_' (1 char) = 8 chars
      // random = 32 bytes = 43 base64url chars
      // Total minimum: 8 + 43 = 51 chars
      expect(result.token.length).toBeGreaterThanOrEqual(51);
    });
  });

  describe('integration', () => {
    it('should support refresh token workflow', () => {
      // Generate a new refresh token
      const { token, hash, tokenPrefix } = generateToken('ps_refresh');

      // Verify the hash can be used for lookup
      const lookupHash = hashToken(token);
      expect(lookupHash).toBe(hash);

      // Verify prefix is useful for debugging
      expect(token.startsWith(tokenPrefix.substring(0, 10))).toBe(true);
    });

    it('should support MCP token workflow', () => {
      const { token, hash, tokenPrefix } = generateToken('mcp');

      expect(token).toMatch(/^mcp_/);
      expect(hashToken(token)).toBe(hash);
      expect(tokenPrefix).toBe(token.substring(0, 12));
    });
  });
});

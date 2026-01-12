import { describe, it, expect } from 'vitest';
import {
  generateOpaqueToken,
  isValidTokenFormat,
  getTokenType,
  type TokenType,
} from '../opaque-tokens';
import { hashToken } from '../token-utils';

describe('Opaque Token Generation', () => {
  it('generates token with correct format', () => {
    const { token, tokenHash, tokenPrefix } = generateOpaqueToken('sess');

    expect(token).toMatch(/^ps_sess_[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toHaveLength(64); // SHA-256 hex
    expect(tokenPrefix).toBe(token.substring(0, 12));
  });

  it('generates unique tokens each call', () => {
    const token1 = generateOpaqueToken('svc');
    const token2 = generateOpaqueToken('svc');

    expect(token1.token).not.toBe(token2.token);
    expect(token1.tokenHash).not.toBe(token2.tokenHash);
  });

  it('hash is deterministic for same token', () => {
    const token = 'ps_sess_testtoken123';
    const hash1 = hashToken(token);
    const hash2 = hashToken(token);

    expect(hash1).toBe(hash2);
  });

  it('validates correct token formats', () => {
    expect(isValidTokenFormat('ps_sess_' + 'a'.repeat(43))).toBe(true);
    expect(isValidTokenFormat('ps_svc_' + 'b'.repeat(43))).toBe(true);
    expect(isValidTokenFormat('ps_mcp_' + 'c'.repeat(43))).toBe(true);
    expect(isValidTokenFormat('ps_dev_' + 'd'.repeat(43))).toBe(true);
  });

  it('rejects invalid token formats', () => {
    expect(isValidTokenFormat('invalid')).toBe(false);
    expect(isValidTokenFormat('ps_invalid_' + 'a'.repeat(43))).toBe(false);
    expect(isValidTokenFormat('ps_sess_' + 'a'.repeat(10))).toBe(false); // Too short
    expect(isValidTokenFormat('ps_sess_' + 'a'.repeat(200))).toBe(false); // Too long
    expect(isValidTokenFormat(123 as any)).toBe(false); // Not a string
  });

  it('extracts correct token type', () => {
    expect(getTokenType('ps_sess_abc123')).toBe('sess');
    expect(getTokenType('ps_svc_abc123')).toBe('svc');
    expect(getTokenType('ps_mcp_abc123')).toBe('mcp');
    expect(getTokenType('ps_dev_abc123')).toBe('dev');
    expect(getTokenType('invalid_token')).toBe(null);
  });

  it('token has sufficient entropy (256 bits)', () => {
    const { token } = generateOpaqueToken('sess');
    // Token format: ps_sess_<43-char-random>
    // Remove the prefix to get the random part
    const randomPart = token.substring('ps_sess_'.length);

    // base64url encoding: 4 chars per 3 bytes
    // 43 chars = ~32 bytes = 256 bits
    expect(randomPart.length).toBe(43);
  });
});

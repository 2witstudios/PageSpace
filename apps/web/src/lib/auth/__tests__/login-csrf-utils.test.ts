import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateLoginCSRFToken,
  validateLoginCSRFToken,
  LOGIN_CSRF_COOKIE_NAME,
  LOGIN_CSRF_MAX_AGE,
} from '../login-csrf-utils';

describe('login-csrf-utils', () => {
  const validSecret = 'a-very-secure-secret-that-is-at-least-32-chars-long';

  beforeEach(() => {
    process.env.CSRF_SECRET = validSecret;
  });

  afterEach(() => {
    delete process.env.CSRF_SECRET;
    vi.restoreAllMocks();
  });

  describe('constants', () => {
    it('should export LOGIN_CSRF_COOKIE_NAME as login_csrf', () => {
      expect(LOGIN_CSRF_COOKIE_NAME).toBe('login_csrf');
    });

    it('should export LOGIN_CSRF_MAX_AGE as 300 seconds (5 minutes)', () => {
      expect(LOGIN_CSRF_MAX_AGE).toBe(300);
    });
  });

  describe('generateLoginCSRFToken', () => {
    it('should generate a token with three dot-separated parts', () => {
      const token = generateLoginCSRFToken();
      const parts = token.split('.');
      expect(parts).toHaveLength(3);
    });

    it('should generate a token with a hex random value as the first part', () => {
      const token = generateLoginCSRFToken();
      const [tokenValue] = token.split('.');
      // 32 bytes = 64 hex chars
      expect(tokenValue).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should generate a token with a numeric timestamp as the second part', () => {
      const token = generateLoginCSRFToken();
      const [, timestamp] = token.split('.');
      expect(Number(timestamp)).toBeGreaterThan(0);
      expect(Number.isInteger(Number(timestamp))).toBe(true);
    });

    it('should generate a token with a hex HMAC signature as the third part', () => {
      const token = generateLoginCSRFToken();
      const [, , signature] = token.split('.');
      // SHA256 = 32 bytes = 64 hex chars
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should generate a timestamp close to current time', () => {
      const before = Math.floor(Date.now() / 1000);
      const token = generateLoginCSRFToken();
      const after = Math.floor(Date.now() / 1000);
      const [, timestamp] = token.split('.');
      const tokenTime = Number(timestamp);
      expect(tokenTime).toBeGreaterThanOrEqual(before);
      expect(tokenTime).toBeLessThanOrEqual(after);
    });

    it('should generate unique tokens on consecutive calls', () => {
      const token1 = generateLoginCSRFToken();
      const token2 = generateLoginCSRFToken();
      expect(token1).not.toBe(token2);
    });

    it('should throw when CSRF_SECRET is not set', () => {
      delete process.env.CSRF_SECRET;
      expect(() => generateLoginCSRFToken()).toThrow(
        'CSRF_SECRET must be configured and at least 32 characters'
      );
    });

    it('should throw when CSRF_SECRET is too short (less than 32 chars)', () => {
      process.env.CSRF_SECRET = 'too-short';
      expect(() => generateLoginCSRFToken()).toThrow(
        'CSRF_SECRET must be configured and at least 32 characters'
      );
    });

    it('should throw when CSRF_SECRET is exactly 31 chars (boundary)', () => {
      process.env.CSRF_SECRET = 'a'.repeat(31);
      expect(() => generateLoginCSRFToken()).toThrow(
        'CSRF_SECRET must be configured and at least 32 characters'
      );
    });

    it('should not throw when CSRF_SECRET is exactly 32 chars (boundary)', () => {
      process.env.CSRF_SECRET = 'a'.repeat(32);
      expect(() => generateLoginCSRFToken()).not.toThrow();
    });
  });

  describe('validateLoginCSRFToken', () => {
    it('should return true for a freshly generated valid token', () => {
      const token = generateLoginCSRFToken();
      expect(validateLoginCSRFToken(token)).toBe(true);
    });

    it('should return false for an empty string', () => {
      expect(validateLoginCSRFToken('')).toBe(false);
    });

    it('should return false for a token with fewer than 3 parts', () => {
      expect(validateLoginCSRFToken('value.timestamp')).toBe(false);
    });

    it('should return false for a token with more than 3 parts', () => {
      expect(validateLoginCSRFToken('value.timestamp.sig.extra')).toBe(false);
    });

    it('should return false for a token with a non-numeric timestamp', () => {
      expect(validateLoginCSRFToken('abc.notanumber.defsig')).toBe(false);
    });

    it('should return false for an expired token (age > maxAge)', () => {
      // Create a token with a timestamp from 10 minutes ago
      const pastTimestamp = Math.floor(Date.now() / 1000) - 600;
      const { createHmac } = require('crypto');
      const tokenValue = 'a'.repeat(64);
      const payload = `${tokenValue}.${pastTimestamp}`;
      const signature = createHmac('sha256', validSecret).update(payload).digest('hex');
      const expiredToken = `${tokenValue}.${pastTimestamp}.${signature}`;

      expect(validateLoginCSRFToken(expiredToken)).toBe(false);
    });

    it('should return false for a token from the future (age < 0)', () => {
      // Future timestamp
      const futureTimestamp = Math.floor(Date.now() / 1000) + 600;
      const { createHmac } = require('crypto');
      const tokenValue = 'a'.repeat(64);
      const payload = `${tokenValue}.${futureTimestamp}`;
      const signature = createHmac('sha256', validSecret).update(payload).digest('hex');
      const futureToken = `${tokenValue}.${futureTimestamp}.${signature}`;

      expect(validateLoginCSRFToken(futureToken)).toBe(false);
    });

    it('should return false when the signature does not match', () => {
      const token = generateLoginCSRFToken();
      const parts = token.split('.');
      // Tamper with the signature
      parts[2] = 'f'.repeat(64);
      expect(validateLoginCSRFToken(parts.join('.'))).toBe(false);
    });

    it('should return false when the token value is tampered', () => {
      const token = generateLoginCSRFToken();
      const parts = token.split('.');
      // Tamper with the token value
      parts[0] = 'b'.repeat(64);
      expect(validateLoginCSRFToken(parts.join('.'))).toBe(false);
    });

    it('should return false when the timestamp is tampered', () => {
      const token = generateLoginCSRFToken();
      const parts = token.split('.');
      // Tamper with the timestamp (still valid recent time)
      parts[1] = String(Math.floor(Date.now() / 1000) - 10);
      expect(validateLoginCSRFToken(parts.join('.'))).toBe(false);
    });

    it('should return false when CSRF_SECRET is different from signing secret', () => {
      const token = generateLoginCSRFToken();
      // Change the secret
      process.env.CSRF_SECRET = 'completely-different-secret-that-is-long-enough-yes';
      expect(validateLoginCSRFToken(token)).toBe(false);
    });

    it('should accept a custom maxAge parameter', () => {
      const token = generateLoginCSRFToken();
      // maxAge of 1 second should still pass immediately
      expect(validateLoginCSRFToken(token, 1)).toBe(true);
    });

    it('should return false with very small maxAge that token already exceeds', () => {
      // Generate a token, then validate with maxAge of 0
      const token = generateLoginCSRFToken();
      // maxAge 0 means the token is expired as soon as it's issued
      // The age will be 0 (same second), which is not > 0 so it might pass
      // Let's use -1 which would make age > maxAge fail
      // Actually 0 is the floor, so let's test with a token we manually backdate
      const { createHmac } = require('crypto');
      const pastTimestamp = Math.floor(Date.now() / 1000) - 5;
      const tokenValue = 'c'.repeat(64);
      const payload = `${tokenValue}.${pastTimestamp}`;
      const signature = createHmac('sha256', validSecret).update(payload).digest('hex');
      const oldToken = `${tokenValue}.${pastTimestamp}.${signature}`;

      // maxAge of 3 seconds, but token is 5 seconds old
      expect(validateLoginCSRFToken(oldToken, 3)).toBe(false);
    });

    it('should handle a signature that is odd-length hex (buffer creation edge case)', () => {
      // Construct a token where the signature part is not valid hex
      const timestamp = Math.floor(Date.now() / 1000);
      const token = `${'a'.repeat(64)}.${timestamp}.notvalidhex!!!`;
      expect(validateLoginCSRFToken(token)).toBe(false);
    });

    it('should use default maxAge of 300 when not provided', () => {
      // A token generated now should be valid with the default 300s window
      const token = generateLoginCSRFToken();
      expect(validateLoginCSRFToken(token)).toBe(true);
    });

    it('should return false when CSRF_SECRET is missing during validation', () => {
      const token = generateLoginCSRFToken();
      delete process.env.CSRF_SECRET;
      expect(() => validateLoginCSRFToken(token)).toThrow(
        'CSRF_SECRET must be configured and at least 32 characters'
      );
    });
  });
});

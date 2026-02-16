import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateWebhookToken, verifyWebhookToken } from '../webhook-token';

describe('webhook-token', () => {
  const originalEnv = process.env;
  const TEST_SECRET = 'test-oauth-state-secret';

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.OAUTH_STATE_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('generateWebhookToken', () => {
    it('given userId, should generate valid token', () => {
      const userId = 'user-123';
      const token = generateWebhookToken(userId);

      expect(token).toMatch(/^user-123\.[a-f0-9]{64}$/);
    });

    it('given same userId, should generate same token', () => {
      const userId = 'user-123';
      const token1 = generateWebhookToken(userId);
      const token2 = generateWebhookToken(userId);

      expect(token1).toBe(token2);
    });

    it('given different userIds, should generate different tokens', () => {
      const token1 = generateWebhookToken('user-1');
      const token2 = generateWebhookToken('user-2');

      expect(token1).not.toBe(token2);
    });

    describe('fail-closed behavior', () => {
      const originalNodeEnv = process.env.NODE_ENV;

      afterEach(() => {
        (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
      });

      it('given production without OAUTH_STATE_SECRET, should throw', () => {
        delete process.env.OAUTH_STATE_SECRET;
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

        expect(() => generateWebhookToken('user-123')).toThrow(
          'OAUTH_STATE_SECRET must be configured in production'
        );
      });

      it('given development without OAUTH_STATE_SECRET, should return empty string', () => {
        delete process.env.OAUTH_STATE_SECRET;
        (process.env as Record<string, string | undefined>).NODE_ENV = 'development';

        const token = generateWebhookToken('user-123');
        expect(token).toBe('');
      });

      it('given test mode without OAUTH_STATE_SECRET, should return empty string', () => {
        delete process.env.OAUTH_STATE_SECRET;
        (process.env as Record<string, string | undefined>).NODE_ENV = 'test';

        const token = generateWebhookToken('user-123');
        expect(token).toBe('');
      });
    });
  });

  describe('verifyWebhookToken', () => {
    it('given valid token, should return userId', () => {
      const userId = 'user-456';
      const token = generateWebhookToken(userId);

      const result = verifyWebhookToken(token);

      expect(result).toBe(userId);
    });

    it('given empty token, should return null', () => {
      expect(verifyWebhookToken('')).toBeNull();
    });

    it('given malformed token (no dot), should return null', () => {
      expect(verifyWebhookToken('no-dot-separator')).toBeNull();
    });

    it('given tampered signature, should return null', () => {
      const token = generateWebhookToken('user-123');
      const tampered = token.slice(0, -8) + 'deadbeef';

      expect(verifyWebhookToken(tampered)).toBeNull();
    });

    it('given modified userId, should return null', () => {
      const token = generateWebhookToken('user-original');
      const [, signature] = token.split('.');
      const tampered = `user-attacker.${signature}`;

      expect(verifyWebhookToken(tampered)).toBeNull();
    });

    it('given wrong signature length, should return null', () => {
      expect(verifyWebhookToken('user-123.short')).toBeNull();
    });

    it('given non-hex signature, should return null', () => {
      expect(verifyWebhookToken('user-123.zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull();
    });

    it('given token without secret configured, should return null', () => {
      const token = generateWebhookToken('user-123');
      delete process.env.OAUTH_STATE_SECRET;

      expect(verifyWebhookToken(token)).toBeNull();
    });
  });

  describe('round-trip', () => {
    it('should verify tokens it generates', () => {
      const userId = 'round-trip-user';
      const token = generateWebhookToken(userId);
      const verified = verifyWebhookToken(token);

      expect(verified).toBe(userId);
    });

    it('should handle UUID userIds', () => {
      // UserIds are UUIDs in practice (no dots allowed since token uses dot separator)
      const userId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      const token = generateWebhookToken(userId);
      const verified = verifyWebhookToken(token);

      expect(verified).toBe(userId);
    });
  });
});

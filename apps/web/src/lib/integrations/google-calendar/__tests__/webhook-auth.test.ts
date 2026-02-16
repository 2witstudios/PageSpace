import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { validateWebhookAuth, _resetWarningFlag } from '../webhook-auth';
import { generateWebhookToken } from '../webhook-token';

describe('webhook-auth', () => {
  const originalEnv = process.env;
  const TEST_SECRET = 'test-oauth-state-secret';

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.OAUTH_STATE_SECRET = TEST_SECRET;
    _resetWarningFlag();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('validateWebhookAuth', () => {
    describe('with valid configuration', () => {
      it('given valid token, should return userId', () => {
        const userId = 'user-123';
        const token = generateWebhookToken(userId);

        const result = validateWebhookAuth(token);

        expect(result).toEqual({ userId });
      });

      it('given missing token (null), should return 401', async () => {
        const result = validateWebhookAuth(null);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);

        const data = await (result as Response).json();
        expect(data.error).toBe('Missing authentication token');
      });

      it('given empty token, should return 401 as missing', async () => {
        const result = validateWebhookAuth('');

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);

        const data = await (result as Response).json();
        // Empty string is treated as missing (falsy value)
        expect(data.error).toBe('Missing authentication token');
      });

      it('given malformed token (no dot separator), should return 401', async () => {
        const result = validateWebhookAuth('malformed-token-no-dot');

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);

        const data = await (result as Response).json();
        expect(data.error).toBe('Invalid authentication token');
      });

      it('given tampered token signature, should return 401', async () => {
        const userId = 'user-456';
        const token = generateWebhookToken(userId);
        const tamperedToken = token.slice(0, -8) + 'deadbeef';

        const result = validateWebhookAuth(tamperedToken);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);

        const data = await (result as Response).json();
        expect(data.error).toBe('Invalid authentication token');
      });

      it('given token with modified userId, should return 401', async () => {
        const originalToken = generateWebhookToken('user-original');
        const [, signature] = originalToken.split('.');
        const tamperedToken = `user-attacker.${signature}`;

        const result = validateWebhookAuth(tamperedToken);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);

        const data = await (result as Response).json();
        expect(data.error).toBe('Invalid authentication token');
      });

      it('given token signed with different secret, should return 401', async () => {
        // Generate token with current secret
        const token = generateWebhookToken('user-789');

        // Change secret and try to verify
        process.env.OAUTH_STATE_SECRET = 'different-secret';

        const result = validateWebhookAuth(token);

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);

        const data = await (result as Response).json();
        expect(data.error).toBe('Invalid authentication token');
      });
    });

    describe('fail-closed behavior without OAUTH_STATE_SECRET', () => {
      const originalNodeEnv = process.env.NODE_ENV;

      beforeEach(() => {
        delete process.env.OAUTH_STATE_SECRET;
        _resetWarningFlag();
      });

      afterEach(() => {
        (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
      });

      it('given production mode without secret, should return 500', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

        const result = validateWebhookAuth('any-token');

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(500);

        const data = await (result as Response).json();
        expect(data.error).toContain('not configured');
      });

      it('given development mode without secret, should return 401', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'development';

        const result = validateWebhookAuth('any-token');

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);

        const data = await (result as Response).json();
        expect(data.error).toBe('Missing authentication token');
      });

      it('given test mode without secret, should return 401', async () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'test';

        const result = validateWebhookAuth('any-token');

        expect(result).toBeInstanceOf(Response);
        expect((result as Response).status).toBe(401);

        const data = await (result as Response).json();
        expect(data.error).toBe('Missing authentication token');
      });

      it('should only log warning once in non-production', () => {
        (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
        const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        validateWebhookAuth('token-1');
        validateWebhookAuth('token-2');
        validateWebhookAuth('token-3');

        expect(consoleSpy).toHaveBeenCalledTimes(1);
        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining('OAUTH_STATE_SECRET is not configured')
        );

        consoleSpy.mockRestore();
      });
    });
  });
});

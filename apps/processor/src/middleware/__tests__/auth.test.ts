import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Auth Middleware Tests
 *
 * Validates that authentication cannot be accidentally disabled in production.
 * The AUTH_REQUIRED flag should:
 * - Always be true when PROCESSOR_AUTH_REQUIRED is not set
 * - Always be true when PROCESSOR_AUTH_REQUIRED=true
 * - Throw an error if PROCESSOR_AUTH_REQUIRED=false in production
 * - Only allow PROCESSOR_AUTH_REQUIRED=false in development mode
 */

// Mock all external dependencies that auth.ts imports
vi.mock('@pagespace/lib/auth', () => ({
  sessionService: {
    validateSession: vi.fn(),
  },
}));

vi.mock('@pagespace/lib/permissions', () => ({
  EnforcedAuthContext: {
    fromSession: vi.fn(),
  },
}));

describe('AUTH_REQUIRED security behavior', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  describe('given PROCESSOR_AUTH_REQUIRED is not set', () => {
    it('should require auth (AUTH_REQUIRED = true)', async () => {
      delete process.env.PROCESSOR_AUTH_REQUIRED;
      delete process.env.NODE_ENV;

      const { AUTH_REQUIRED } = await import('../auth');
      expect(AUTH_REQUIRED).toBe(true);
    });
  });

  describe('given PROCESSOR_AUTH_REQUIRED=true', () => {
    it('should require auth (AUTH_REQUIRED = true)', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = 'true';
      delete process.env.NODE_ENV;

      const { AUTH_REQUIRED } = await import('../auth');
      expect(AUTH_REQUIRED).toBe(true);
    });
  });

  describe('given PROCESSOR_AUTH_REQUIRED=false in production', () => {
    it('should throw an error refusing to disable auth', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = 'false';
      process.env.NODE_ENV = 'production';

      await expect(import('../auth')).rejects.toThrow(
        'PROCESSOR_AUTH_REQUIRED=false is only allowed in development mode'
      );
    });
  });

  describe('given PROCESSOR_AUTH_REQUIRED=false with NODE_ENV unset', () => {
    it('should throw an error (fail-safe: unset NODE_ENV is not development)', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = 'false';
      delete process.env.NODE_ENV;

      await expect(import('../auth')).rejects.toThrow(
        'PROCESSOR_AUTH_REQUIRED=false is only allowed in development mode'
      );
    });
  });

  describe('given PROCESSOR_AUTH_REQUIRED=false in development', () => {
    it('should allow auth to be disabled (AUTH_REQUIRED = false)', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = 'false';
      process.env.NODE_ENV = 'development';

      const { AUTH_REQUIRED } = await import('../auth');
      expect(AUTH_REQUIRED).toBe(false);
    });
  });

  describe('given PROCESSOR_AUTH_REQUIRED=false in test mode', () => {
    it('should throw an error (test mode is not development)', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = 'false';
      process.env.NODE_ENV = 'test';

      await expect(import('../auth')).rejects.toThrow(
        'PROCESSOR_AUTH_REQUIRED=false is only allowed in development mode'
      );
    });
  });

  describe('given random PROCESSOR_AUTH_REQUIRED value', () => {
    it('should require auth for any value other than false', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = 'yes';
      delete process.env.NODE_ENV;

      const { AUTH_REQUIRED } = await import('../auth');
      expect(AUTH_REQUIRED).toBe(true);
    });
  });

  describe('given empty string PROCESSOR_AUTH_REQUIRED', () => {
    it('should require auth (empty string is not false)', async () => {
      process.env.PROCESSOR_AUTH_REQUIRED = '';
      delete process.env.NODE_ENV;

      const { AUTH_REQUIRED } = await import('../auth');
      expect(AUTH_REQUIRED).toBe(true);
    });
  });
});

/**
 * @scaffold - CORS validation is inline in server.ts and not exported.
 * Functions are re-implemented here to characterize the validation logic.
 * Suggested: extract and export validation functions for direct unit testing.
 *
 * Tests verify the defense-in-depth CORS configuration that:
 * - Allows configured origins (CORS_ORIGIN, WEB_APP_URL, ADDITIONAL_ALLOWED_ORIGINS)
 * - Allows non-browser clients (no Origin header)
 * - Fails closed in production when no origins configured
 * - Allows all origins in development when misconfigured
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger at system boundary
vi.mock('@pagespace/lib/logger-config', () => ({
  loggers: {
    processor: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import { loggers } from '@pagespace/lib/logger-config';

/**
 * Re-implement the origin validation functions from server.ts for testing.
 * These mirror the actual implementation to verify the logic without
 * needing to export internal functions from the main module.
 */

/**
 * Normalizes an origin URL by extracting protocol, host, and port
 */
function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return '';
  }
}

/**
 * Gets the list of allowed origins from environment configuration
 */
function getAllowedOrigins(): string[] {
  const origins: string[] = [];

  const corsOrigin = process.env.CORS_ORIGIN;
  const webAppUrl = process.env.WEB_APP_URL;

  if (corsOrigin) {
    const normalized = normalizeOrigin(corsOrigin);
    if (normalized) origins.push(normalized);
  } else if (webAppUrl) {
    const normalized = normalizeOrigin(webAppUrl);
    if (normalized) origins.push(normalized);
  }

  const additional = process.env.ADDITIONAL_ALLOWED_ORIGINS;
  if (additional) {
    origins.push(
      ...additional
        .split(',')
        .map((o) => normalizeOrigin(o.trim()))
        .filter((o) => o.length > 0)
    );
  }

  return origins;
}

/**
 * Result of CORS origin callback
 */
interface CorsCallbackResult {
  error: Error | null;
  allowed: boolean;
}

/**
 * Simulates the CORS origin callback behavior from server.ts
 * Returns the result that would be passed to the cors middleware callback
 */
function validateCorsOrigin(origin: string | undefined): CorsCallbackResult {
  // No origin = non-browser client (curl, MCP, mobile) - allow
  if (!origin) {
    return { error: null, allowed: true };
  }

  const allowedOrigins = getAllowedOrigins();

  // No config in production = fail closed
  if (allowedOrigins.length === 0) {
    const isProduction = process.env.NODE_ENV === 'production';
    if (isProduction) {
      loggers.processor.error('CORS rejected: no allowed origins configured', {
        origin,
        severity: 'security',
      });
      return { error: new Error('CORS not configured'), allowed: false };
    }
    loggers.processor.warn('CORS: no allowed origins configured (allowing in dev)', { origin });
    return { error: null, allowed: true };
  }

  // Check origin against allowed list
  const normalized = normalizeOrigin(origin);
  if (allowedOrigins.includes(normalized)) {
    return { error: null, allowed: true };
  }

  // Reject unknown origin
  loggers.processor.warn('CORS rejected: origin not in allowed list', {
    origin,
    allowedOrigins,
    severity: 'security',
  });
  return { error: new Error('Origin not allowed'), allowed: false };
}

describe('Processor CORS Validation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CORS_ORIGIN;
    delete process.env.WEB_APP_URL;
    delete process.env.ADDITIONAL_ALLOWED_ORIGINS;
    delete process.env.NODE_ENV;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  describe('normalizeOrigin', () => {
    it('given valid https URL, should return normalized origin', () => {
      const result = normalizeOrigin('https://app.example.com/path?query=value');
      expect(result).toBe('https://app.example.com');
    });

    it('given valid http URL with port, should preserve port', () => {
      const result = normalizeOrigin('http://localhost:3000/api');
      expect(result).toBe('http://localhost:3000');
    });

    it('given invalid URL, should return empty string', () => {
      const result = normalizeOrigin('not-a-valid-url');
      expect(result).toBe('');
    });

    it('given empty string, should return empty string', () => {
      const result = normalizeOrigin('');
      expect(result).toBe('');
    });
  });

  describe('getAllowedOrigins', () => {
    it('given CORS_ORIGIN set, should return normalized CORS_ORIGIN', () => {
      process.env.CORS_ORIGIN = 'https://app.example.com';
      const result = getAllowedOrigins();
      expect(result).toEqual(['https://app.example.com']);
    });

    it('given WEB_APP_URL set without CORS_ORIGIN, should return normalized WEB_APP_URL', () => {
      process.env.WEB_APP_URL = 'https://webapp.example.com';
      const result = getAllowedOrigins();
      expect(result).toEqual(['https://webapp.example.com']);
    });

    it('given CORS_ORIGIN preferred over WEB_APP_URL, should use CORS_ORIGIN', () => {
      process.env.CORS_ORIGIN = 'https://cors.example.com';
      process.env.WEB_APP_URL = 'https://webapp.example.com';
      const result = getAllowedOrigins();
      expect(result).toEqual(['https://cors.example.com']);
    });

    it('given ADDITIONAL_ALLOWED_ORIGINS, should include additional origins', () => {
      process.env.WEB_APP_URL = 'https://app.example.com';
      process.env.ADDITIONAL_ALLOWED_ORIGINS = 'https://staging.example.com,https://dev.example.com';
      const result = getAllowedOrigins();
      expect(result).toEqual([
        'https://app.example.com',
        'https://staging.example.com',
        'https://dev.example.com',
      ]);
    });

    it('given ADDITIONAL_ALLOWED_ORIGINS with whitespace, should trim values', () => {
      process.env.WEB_APP_URL = 'https://app.example.com';
      process.env.ADDITIONAL_ALLOWED_ORIGINS =
        '  https://staging.example.com  ,  https://dev.example.com  ';
      const result = getAllowedOrigins();
      expect(result).toEqual([
        'https://app.example.com',
        'https://staging.example.com',
        'https://dev.example.com',
      ]);
    });

    it('given no configuration, should return empty array', () => {
      const result = getAllowedOrigins();
      expect(result).toEqual([]);
    });

    it('given invalid URLs in ADDITIONAL_ALLOWED_ORIGINS, should filter them out', () => {
      process.env.WEB_APP_URL = 'https://app.example.com';
      process.env.ADDITIONAL_ALLOWED_ORIGINS = 'https://valid.example.com,not-a-url,https://also-valid.example.com';
      const result = getAllowedOrigins();
      expect(result).toEqual([
        'https://app.example.com',
        'https://valid.example.com',
        'https://also-valid.example.com',
      ]);
    });
  });

  describe('validateCorsOrigin', () => {
    describe('non-browser client handling', () => {
      it('given undefined origin (curl/MCP/mobile), should allow without logging', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateCorsOrigin(undefined);

        expect(result.error).toBeNull();
        expect(result.allowed).toBe(true);
        expect(loggers.processor.warn).not.toHaveBeenCalled();
        expect(loggers.processor.error).not.toHaveBeenCalled();
      });
    });

    describe('valid origin matching', () => {
      it('given origin matches WEB_APP_URL, should allow', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateCorsOrigin('https://app.example.com');

        expect(result.error).toBeNull();
        expect(result.allowed).toBe(true);
      });

      it('given origin matches CORS_ORIGIN, should allow', () => {
        process.env.CORS_ORIGIN = 'https://cors.example.com';
        const result = validateCorsOrigin('https://cors.example.com');

        expect(result.error).toBeNull();
        expect(result.allowed).toBe(true);
      });

      it('given origin matches ADDITIONAL_ALLOWED_ORIGINS, should allow', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        process.env.ADDITIONAL_ALLOWED_ORIGINS = 'https://staging.example.com';
        const result = validateCorsOrigin('https://staging.example.com');

        expect(result.error).toBeNull();
        expect(result.allowed).toBe(true);
      });

      it('given origin with path matches allowed origin, should allow', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateCorsOrigin('https://app.example.com/some/path');

        expect(result.error).toBeNull();
        expect(result.allowed).toBe(true);
      });
    });

    describe('invalid origin rejection', () => {
      it('given origin not in allowed list, should reject with error', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateCorsOrigin('https://evil.example.com');

        expect(result.error).toBeInstanceOf(Error);
        expect(result.error?.message).toBe('Origin not allowed');
        expect(result.allowed).toBe(false);
      });

      it('given subdomain not explicitly allowed, should reject', () => {
        process.env.WEB_APP_URL = 'https://example.com';
        const result = validateCorsOrigin('https://app.example.com');

        expect(result.error).toBeInstanceOf(Error);
        expect(result.allowed).toBe(false);
      });

      it('given protocol mismatch (http vs https), should reject', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateCorsOrigin('http://app.example.com');

        expect(result.error).toBeInstanceOf(Error);
        expect(result.allowed).toBe(false);
      });

      it('given port mismatch, should reject', () => {
        process.env.WEB_APP_URL = 'http://localhost:3000';
        const result = validateCorsOrigin('http://localhost:3001');

        expect(result.error).toBeInstanceOf(Error);
        expect(result.allowed).toBe(false);
      });

      it('given rejected origin, should log security warning', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        validateCorsOrigin('https://evil.example.com');

        expect(loggers.processor.warn).toHaveBeenCalledWith(
          'CORS rejected: origin not in allowed list',
          expect.objectContaining({
            origin: 'https://evil.example.com',
            allowedOrigins: ['https://app.example.com'],
            severity: 'security',
          })
        );
      });
    });

    describe('production fail-closed behavior', () => {
      it('given no config in production, should reject with error', () => {
        process.env.NODE_ENV = 'production';
        const result = validateCorsOrigin('https://any-origin.example.com');

        expect(result.error).toBeInstanceOf(Error);
        expect(result.error?.message).toBe('CORS not configured');
        expect(result.allowed).toBe(false);
      });

      it('given no config in production, should log security error', () => {
        process.env.NODE_ENV = 'production';
        validateCorsOrigin('https://any-origin.example.com');

        expect(loggers.processor.error).toHaveBeenCalledWith(
          'CORS rejected: no allowed origins configured',
          expect.objectContaining({
            origin: 'https://any-origin.example.com',
            severity: 'security',
          })
        );
      });
    });

    describe('development fallback behavior', () => {
      it('given no config in development, should allow with warning', () => {
        process.env.NODE_ENV = 'development';
        const result = validateCorsOrigin('https://any-origin.example.com');

        expect(result.error).toBeNull();
        expect(result.allowed).toBe(true);
      });

      it('given no config in development, should log warning', () => {
        process.env.NODE_ENV = 'development';
        validateCorsOrigin('https://any-origin.example.com');

        expect(loggers.processor.warn).toHaveBeenCalledWith(
          'CORS: no allowed origins configured (allowing in dev)',
          expect.objectContaining({
            origin: 'https://any-origin.example.com',
          })
        );
      });

      it('given no NODE_ENV set (defaults to non-production), should allow with warning', () => {
        // NODE_ENV is deleted in beforeEach
        const result = validateCorsOrigin('https://any-origin.example.com');

        expect(result.error).toBeNull();
        expect(result.allowed).toBe(true);
        expect(loggers.processor.warn).toHaveBeenCalledWith(
          expect.stringContaining('CORS'),
          expect.any(Object)
        );
      });
    });

    describe('URL normalization edge cases', () => {
      it('given malformed origin URL, should reject', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateCorsOrigin('not-a-valid-url');

        expect(result.error).toBeInstanceOf(Error);
        expect(result.allowed).toBe(false);
      });

      it('given origin with query string, should normalize and match', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateCorsOrigin('https://app.example.com?foo=bar');

        expect(result.error).toBeNull();
        expect(result.allowed).toBe(true);
      });
    });
  });

  describe('integration scenarios', () => {
    describe('localhost development', () => {
      it('given localhost origin matching WEB_APP_URL, should allow', () => {
        process.env.WEB_APP_URL = 'http://localhost:3000';
        const result = validateCorsOrigin('http://localhost:3000');

        expect(result.error).toBeNull();
        expect(result.allowed).toBe(true);
      });

      it('given 127.0.0.1 not matching localhost WEB_APP_URL, should reject', () => {
        process.env.WEB_APP_URL = 'http://localhost:3000';
        const result = validateCorsOrigin('http://127.0.0.1:3000');

        expect(result.error).toBeInstanceOf(Error);
        expect(result.allowed).toBe(false);
      });
    });

    describe('multi-origin setup', () => {
      it('given production and staging configured, should allow both', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        process.env.ADDITIONAL_ALLOWED_ORIGINS = 'https://staging.example.com';

        const prodResult = validateCorsOrigin('https://app.example.com');
        const stagingResult = validateCorsOrigin('https://staging.example.com');

        expect(prodResult.allowed).toBe(true);
        expect(stagingResult.allowed).toBe(true);
      });

      it('given unlisted origin with multiple configured, should reject', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        process.env.ADDITIONAL_ALLOWED_ORIGINS = 'https://staging.example.com,https://dev.example.com';
        const result = validateCorsOrigin('https://test.example.com');

        expect(result.error).toBeInstanceOf(Error);
        expect(result.allowed).toBe(false);
      });
    });

    describe('service-to-service requests', () => {
      it('given MCP client without Origin header, should allow (auth handled by middleware)', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateCorsOrigin(undefined);

        expect(result.error).toBeNull();
        expect(result.allowed).toBe(true);
      });

      it('given curl request without Origin header, should allow', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateCorsOrigin(undefined);

        expect(result.error).toBeNull();
        expect(result.allowed).toBe(true);
      });
    });
  });
});

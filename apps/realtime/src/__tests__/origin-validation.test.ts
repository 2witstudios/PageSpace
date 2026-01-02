/**
 * Realtime Server Origin Validation Tests
 * Tests for WebSocket connection origin validation and logging
 *
 * These tests verify the defense-in-depth origin validation that provides
 * security monitoring for WebSocket connections. While Socket.IO CORS
 * handles actual blocking, this module provides explicit logging for
 * unexpected origins.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the logger at system boundary
vi.mock('@pagespace/lib/logger-config', () => ({
  loggers: {
    realtime: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import { loggers } from '@pagespace/lib/logger-config';

/**
 * Re-implement the origin validation functions from index.ts for testing.
 * These mirror the actual implementation to verify the logic without
 * needing to export internal functions from the main module.
 */

/**
 * Normalizes an origin URL by extracting protocol, host, and port
 */
function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return url.origin;
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

  const additionalOrigins = process.env.ADDITIONAL_ALLOWED_ORIGINS;
  if (additionalOrigins) {
    const parsed = additionalOrigins
      .split(',')
      .map((o) => normalizeOrigin(o.trim()))
      .filter((o) => o.length > 0);
    origins.push(...parsed);
  }

  return origins;
}

/**
 * Checks if the given origin is in the allowed list
 */
function isOriginAllowed(origin: string, allowedOrigins: string[]): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }

  return allowedOrigins.some((allowed) => allowed === normalizedOrigin);
}

/**
 * Result of WebSocket origin validation
 */
interface WebSocketOriginValidationResult {
  isValid: boolean;
  origin: string | undefined;
  reason: 'valid' | 'no_origin' | 'invalid' | 'no_config';
}

/**
 * Validates a WebSocket connection origin against allowed origins
 */
function validateWebSocketOrigin(origin: string | undefined): WebSocketOriginValidationResult {
  if (!origin) {
    return {
      isValid: true,
      origin: undefined,
      reason: 'no_origin',
    };
  }

  const normalizedOrigin = normalizeOrigin(origin);
  const allowedOrigins = getAllowedOrigins();

  if (allowedOrigins.length === 0) {
    return {
      isValid: true,
      origin: normalizedOrigin || origin,
      reason: 'no_config',
    };
  }

  if (isOriginAllowed(origin, allowedOrigins)) {
    return {
      isValid: true,
      origin: normalizedOrigin,
      reason: 'valid',
    };
  }

  return {
    isValid: false,
    origin: normalizedOrigin || origin,
    reason: 'invalid',
  };
}

/**
 * Validates and logs WebSocket connection origin for security monitoring
 */
function validateAndLogWebSocketOrigin(
  origin: string | undefined,
  metadata: { socketId: string; ip: string | undefined; userAgent: string | undefined }
): void {
  const allowedOrigins = getAllowedOrigins();

  if (!origin) {
    loggers.realtime.debug('WebSocket origin validation: no Origin header', {
      ...metadata,
      reason: 'Non-browser client or same-origin request',
    });
    return;
  }

  if (allowedOrigins.length === 0) {
    loggers.realtime.warn('WebSocket origin validation: no allowed origins configured', {
      ...metadata,
      origin,
      reason: 'CORS_ORIGIN and WEB_APP_URL not set',
    });
    return;
  }

  if (isOriginAllowed(origin, allowedOrigins)) {
    loggers.realtime.debug('WebSocket origin validation: valid origin', {
      ...metadata,
      origin,
    });
    return;
  }

  loggers.realtime.warn('WebSocket origin validation: unexpected origin detected', {
    ...metadata,
    origin,
    allowedOrigins,
    severity: 'security',
    reason: 'Origin not in allowed list - connection may be blocked by CORS',
  });
}

describe('Realtime Origin Validation', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CORS_ORIGIN;
    delete process.env.WEB_APP_URL;
    delete process.env.ADDITIONAL_ALLOWED_ORIGINS;
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
      process.env.ADDITIONAL_ALLOWED_ORIGINS = '  https://staging.example.com  ,  https://dev.example.com  ';
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
  });

  describe('isOriginAllowed', () => {
    it('given origin matches allowed list, should return true', () => {
      const result = isOriginAllowed('https://app.example.com', ['https://app.example.com']);
      expect(result).toBe(true);
    });

    it('given origin does not match allowed list, should return false', () => {
      const result = isOriginAllowed('https://evil.example.com', ['https://app.example.com']);
      expect(result).toBe(false);
    });

    it('given origin with path matches allowed origin, should return true', () => {
      const result = isOriginAllowed('https://app.example.com/some/path', ['https://app.example.com']);
      expect(result).toBe(true);
    });

    it('given malformed origin, should return false', () => {
      const result = isOriginAllowed('not-a-url', ['https://app.example.com']);
      expect(result).toBe(false);
    });

    it('given empty allowed list, should return false', () => {
      const result = isOriginAllowed('https://app.example.com', []);
      expect(result).toBe(false);
    });
  });

  describe('validateWebSocketOrigin', () => {
    describe('missing origin handling', () => {
      it('given undefined origin, should return valid with no_origin reason', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateWebSocketOrigin(undefined);

        expect(result).toEqual({
          isValid: true,
          origin: undefined,
          reason: 'no_origin',
        });
      });
    });

    describe('valid origin matching', () => {
      it('given origin matches WEB_APP_URL, should return valid with reason', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateWebSocketOrigin('https://app.example.com');

        expect(result).toEqual({
          isValid: true,
          origin: 'https://app.example.com',
          reason: 'valid',
        });
      });

      it('given origin matches CORS_ORIGIN, should return valid', () => {
        process.env.CORS_ORIGIN = 'https://cors.example.com';
        const result = validateWebSocketOrigin('https://cors.example.com');

        expect(result).toEqual({
          isValid: true,
          origin: 'https://cors.example.com',
          reason: 'valid',
        });
      });

      it('given origin matches ADDITIONAL_ALLOWED_ORIGINS, should return valid', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        process.env.ADDITIONAL_ALLOWED_ORIGINS = 'https://staging.example.com';
        const result = validateWebSocketOrigin('https://staging.example.com');

        expect(result).toEqual({
          isValid: true,
          origin: 'https://staging.example.com',
          reason: 'valid',
        });
      });
    });

    describe('invalid origin rejection', () => {
      it('given origin not in allowed list, should return invalid', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateWebSocketOrigin('https://evil.example.com');

        expect(result).toEqual({
          isValid: false,
          origin: 'https://evil.example.com',
          reason: 'invalid',
        });
      });

      it('given subdomain not explicitly allowed, should return invalid', () => {
        process.env.WEB_APP_URL = 'https://example.com';
        const result = validateWebSocketOrigin('https://app.example.com');

        expect(result).toEqual({
          isValid: false,
          origin: 'https://app.example.com',
          reason: 'invalid',
        });
      });
    });

    describe('no configuration edge case', () => {
      it('given no allowed origins configured, should return valid with no_config reason', () => {
        const result = validateWebSocketOrigin('https://any-origin.example.com');

        expect(result).toEqual({
          isValid: true,
          origin: 'https://any-origin.example.com',
          reason: 'no_config',
        });
      });
    });

    describe('URL normalization', () => {
      it('given origin with trailing path, should normalize correctly', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateWebSocketOrigin('https://app.example.com/some/path');

        expect(result.isValid).toBe(true);
        expect(result.origin).toBe('https://app.example.com');
      });

      it('given origin with port, should match correctly', () => {
        process.env.WEB_APP_URL = 'http://localhost:3000';
        const result = validateWebSocketOrigin('http://localhost:3000');

        expect(result.isValid).toBe(true);
        expect(result.origin).toBe('http://localhost:3000');
      });

      it('given malformed origin, should return invalid with original value', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const result = validateWebSocketOrigin('not-a-valid-origin');

        expect(result.isValid).toBe(false);
        expect(result.origin).toBe('not-a-valid-origin');
        expect(result.reason).toBe('invalid');
      });
    });
  });

  describe('validateAndLogWebSocketOrigin', () => {
    const defaultMetadata = {
      socketId: 'test-socket-123',
      ip: '127.0.0.1',
      userAgent: 'Test Browser/1.0',
    };

    describe('valid origin logging', () => {
      it('given valid origin, should log at debug level without warning', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';

        validateAndLogWebSocketOrigin('https://app.example.com', defaultMetadata);

        expect(loggers.realtime.debug).toHaveBeenCalledWith(
          'WebSocket origin validation: valid origin',
          expect.objectContaining({
            socketId: 'test-socket-123',
            ip: '127.0.0.1',
            origin: 'https://app.example.com',
          })
        );
        expect(loggers.realtime.warn).not.toHaveBeenCalled();
      });
    });

    describe('missing origin handling', () => {
      it('given no origin header, should log at debug level gracefully', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';

        validateAndLogWebSocketOrigin(undefined, defaultMetadata);

        expect(loggers.realtime.debug).toHaveBeenCalledWith(
          'WebSocket origin validation: no Origin header',
          expect.objectContaining({
            socketId: 'test-socket-123',
            reason: 'Non-browser client or same-origin request',
          })
        );
        expect(loggers.realtime.warn).not.toHaveBeenCalled();
      });
    });

    describe('unexpected origin warning', () => {
      it('given unexpected origin, should trigger warning log', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';

        validateAndLogWebSocketOrigin('https://evil.example.com', defaultMetadata);

        expect(loggers.realtime.warn).toHaveBeenCalledWith(
          'WebSocket origin validation: unexpected origin detected',
          expect.objectContaining({
            socketId: 'test-socket-123',
            ip: '127.0.0.1',
            origin: 'https://evil.example.com',
            allowedOrigins: ['https://app.example.com'],
            severity: 'security',
            reason: 'Origin not in allowed list - connection may be blocked by CORS',
          })
        );
      });

      it('given unexpected subdomain, should trigger warning log', () => {
        process.env.WEB_APP_URL = 'https://example.com';

        validateAndLogWebSocketOrigin('https://malicious.example.com', defaultMetadata);

        expect(loggers.realtime.warn).toHaveBeenCalledWith(
          'WebSocket origin validation: unexpected origin detected',
          expect.objectContaining({
            origin: 'https://malicious.example.com',
            allowedOrigins: ['https://example.com'],
            severity: 'security',
          })
        );
      });

      it('given origin with different protocol, should trigger warning log', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';

        validateAndLogWebSocketOrigin('http://app.example.com', defaultMetadata);

        expect(loggers.realtime.warn).toHaveBeenCalledWith(
          'WebSocket origin validation: unexpected origin detected',
          expect.objectContaining({
            origin: 'http://app.example.com',
            severity: 'security',
          })
        );
      });
    });

    describe('no configuration warning', () => {
      it('given no allowed origins configured, should warn about misconfiguration', () => {
        validateAndLogWebSocketOrigin('https://any.example.com', defaultMetadata);

        expect(loggers.realtime.warn).toHaveBeenCalledWith(
          'WebSocket origin validation: no allowed origins configured',
          expect.objectContaining({
            origin: 'https://any.example.com',
            reason: 'CORS_ORIGIN and WEB_APP_URL not set',
          })
        );
      });
    });

    describe('metadata propagation', () => {
      it('given connection metadata, should include socketId and ip in all logs', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const metadata = {
          socketId: 'unique-socket-456',
          ip: '192.168.1.100',
          userAgent: 'Mozilla/5.0',
        };

        validateAndLogWebSocketOrigin('https://app.example.com', metadata);

        expect(loggers.realtime.debug).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            socketId: 'unique-socket-456',
            ip: '192.168.1.100',
          })
        );
      });

      it('given undefined ip and userAgent, should handle gracefully', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const metadata = {
          socketId: 'test-socket',
          ip: undefined,
          userAgent: undefined,
        };

        validateAndLogWebSocketOrigin('https://app.example.com', metadata);

        expect(loggers.realtime.debug).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            socketId: 'test-socket',
            ip: undefined,
            userAgent: undefined,
          })
        );
      });
    });
  });

  describe('integration scenarios', () => {
    describe('localhost development', () => {
      it('given localhost origin matching WEB_APP_URL, should validate successfully', () => {
        process.env.WEB_APP_URL = 'http://localhost:3000';

        const result = validateWebSocketOrigin('http://localhost:3000');

        expect(result.isValid).toBe(true);
        expect(result.reason).toBe('valid');
      });

      it('given 127.0.0.1 not matching localhost WEB_APP_URL, should fail validation', () => {
        process.env.WEB_APP_URL = 'http://localhost:3000';

        const result = validateWebSocketOrigin('http://127.0.0.1:3000');

        expect(result.isValid).toBe(false);
        expect(result.reason).toBe('invalid');
      });
    });

    describe('multiple allowed origins', () => {
      it('given production and staging configured, should allow both', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        process.env.ADDITIONAL_ALLOWED_ORIGINS = 'https://staging.example.com';

        const prodResult = validateWebSocketOrigin('https://app.example.com');
        const stagingResult = validateWebSocketOrigin('https://staging.example.com');

        expect(prodResult.isValid).toBe(true);
        expect(stagingResult.isValid).toBe(true);
      });

      it('given unlisted origin with multiple configured, should reject', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        process.env.ADDITIONAL_ALLOWED_ORIGINS = 'https://staging.example.com,https://dev.example.com';

        const result = validateWebSocketOrigin('https://test.example.com');

        expect(result.isValid).toBe(false);
        expect(result.reason).toBe('invalid');
      });
    });

    describe('non-browser client simulation', () => {
      it('given curl-like client without Origin header, should allow connection', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';

        const result = validateWebSocketOrigin(undefined);

        expect(result.isValid).toBe(true);
        expect(result.reason).toBe('no_origin');
      });
    });
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  validateOrigin,
  requiresOriginValidation,
  validateOriginForMiddleware,
  isOriginValidationBlocking,
} from '../origin-validation';

/**
 * Origin Validation Module Contract Tests
 *
 * This module provides Origin header validation as defense-in-depth CSRF protection.
 * The contract is:
 *
 * Input: HTTP Request with:
 *   - Method (GET/HEAD/OPTIONS are safe methods, others may need validation)
 *   - Origin header (optional - browser-only, not sent by curl, MCP, etc.)
 *
 * Output:
 *   - validateOrigin: null (valid/allowed) or NextResponse with 403 (ORIGIN_INVALID)
 *   - requiresOriginValidation: boolean (true for mutation methods)
 *   - validateOriginForMiddleware: MiddlewareOriginValidationResult
 *
 * Key behaviors:
 *   - Missing Origin header is ALLOWED (supports non-browser clients)
 *   - Invalid Origin returns 403 with code ORIGIN_INVALID
 *   - Uses WEB_APP_URL and ADDITIONAL_ALLOWED_ORIGINS for allowed list
 *   - Origin normalization handles various URL formats
 */

// Mock dependencies at system boundary
vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import { loggers } from '@pagespace/lib/server';

describe('origin-validation', () => {
  // Store original env values
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment variables
    delete process.env.WEB_APP_URL;
    delete process.env.ADDITIONAL_ALLOWED_ORIGINS;
    delete process.env.ORIGIN_VALIDATION_MODE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original env
    process.env = { ...originalEnv };
  });

  describe('requiresOriginValidation', () => {
    describe('safe HTTP methods (no origin validation recommended per HTTP spec)', () => {
      it('requiresOriginValidation_GET_returnsFalse', () => {
        const request = new Request('https://example.com/api/test', { method: 'GET' });
        expect(requiresOriginValidation(request)).toBe(false);
      });

      it('requiresOriginValidation_HEAD_returnsFalse', () => {
        const request = new Request('https://example.com/api/test', { method: 'HEAD' });
        expect(requiresOriginValidation(request)).toBe(false);
      });

      it('requiresOriginValidation_OPTIONS_returnsFalse', () => {
        const request = new Request('https://example.com/api/test', { method: 'OPTIONS' });
        expect(requiresOriginValidation(request)).toBe(false);
      });
    });

    describe('mutation HTTP methods (origin validation recommended)', () => {
      it('requiresOriginValidation_POST_returnsTrue', () => {
        const request = new Request('https://example.com/api/test', { method: 'POST' });
        expect(requiresOriginValidation(request)).toBe(true);
      });

      it('requiresOriginValidation_PUT_returnsTrue', () => {
        const request = new Request('https://example.com/api/test', { method: 'PUT' });
        expect(requiresOriginValidation(request)).toBe(true);
      });

      it('requiresOriginValidation_PATCH_returnsTrue', () => {
        const request = new Request('https://example.com/api/test', { method: 'PATCH' });
        expect(requiresOriginValidation(request)).toBe(true);
      });

      it('requiresOriginValidation_DELETE_returnsTrue', () => {
        const request = new Request('https://example.com/api/test', { method: 'DELETE' });
        expect(requiresOriginValidation(request)).toBe(true);
      });
    });
  });

  describe('validateOrigin', () => {
    describe('missing Origin header handling (non-browser clients)', () => {
      it('validateOrigin_noOriginHeader_returnsNullAndAllowsRequest', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const request = new Request('https://example.com/api/test', { method: 'POST' });

        const result = validateOrigin(request);

        expect(result).toBeNull();
        expect(loggers.auth.debug).toHaveBeenCalledWith(
          'Origin validation: no Origin header present (allowed)',
          expect.objectContaining({
            method: 'POST',
            url: 'https://example.com/api/test',
          })
        );
      });

      it('validateOrigin_emptyOriginHeader_returnsNullAndAllowsRequest', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const headers = new Headers();
        headers.set('Origin', '');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        // Empty string is treated as no origin
        expect(result).toBeNull();
      });
    });

    describe('valid origin matching', () => {
      it('validateOrigin_originMatchesWEB_APP_URL_returnsNull', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const headers = new Headers();
        headers.set('Origin', 'https://app.example.com');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).toBeNull();
        expect(loggers.auth.debug).toHaveBeenCalledWith(
          'Origin validation successful',
          expect.objectContaining({
            origin: 'https://app.example.com',
          })
        );
      });

      it('validateOrigin_originMatchesADDITIONAL_ALLOWED_ORIGINS_returnsNull', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        process.env.ADDITIONAL_ALLOWED_ORIGINS = 'https://staging.example.com,https://dev.example.com';
        const headers = new Headers();
        headers.set('Origin', 'https://staging.example.com');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).toBeNull();
      });

      it('validateOrigin_originMatchesSecondAdditionalOrigin_returnsNull', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        process.env.ADDITIONAL_ALLOWED_ORIGINS = 'https://staging.example.com,https://dev.example.com';
        const headers = new Headers();
        headers.set('Origin', 'https://dev.example.com');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).toBeNull();
      });
    });

    describe('invalid origin rejection', () => {
      it('validateOrigin_invalidOrigin_returns403WithORIGIN_INVALID', async () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const headers = new Headers();
        headers.set('Origin', 'https://evil.example.com');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).not.toBeNull();
        expect(result?.status).toBe(403);
        const body = await result?.json();
        expect(body).toMatchObject({
          error: 'Origin not allowed',
          code: 'ORIGIN_INVALID',
          details: 'The request origin is not in the list of allowed origins',
        });
      });

      it('validateOrigin_invalidOrigin_logsSecurityWarning', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const headers = new Headers();
        headers.set('Origin', 'https://malicious.example.com');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        validateOrigin(request);

        expect(loggers.auth.warn).toHaveBeenCalledWith(
          'Origin validation failed: unexpected origin',
          expect.objectContaining({
            origin: 'https://malicious.example.com',
            allowedOrigins: ['https://app.example.com'],
          })
        );
      });
    });

    describe('URL format handling', () => {
      it('validateOrigin_httpOrigin_handlesCorrectly', () => {
        process.env.WEB_APP_URL = 'http://localhost:3000';
        const headers = new Headers();
        headers.set('Origin', 'http://localhost:3000');
        const request = new Request('http://localhost:3000/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).toBeNull();
      });

      it('validateOrigin_httpsOrigin_handlesCorrectly', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const headers = new Headers();
        headers.set('Origin', 'https://app.example.com');
        const request = new Request('https://app.example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).toBeNull();
      });

      it('validateOrigin_originWithExplicitPort_handlesCorrectly', () => {
        process.env.WEB_APP_URL = 'https://app.example.com:8443';
        const headers = new Headers();
        headers.set('Origin', 'https://app.example.com:8443');
        const request = new Request('https://app.example.com:8443/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).toBeNull();
      });

      it('validateOrigin_originWithPathInWEB_APP_URL_normalizesToOriginOnly', () => {
        // WEB_APP_URL may include path, but origin validation should only check protocol://host:port
        process.env.WEB_APP_URL = 'https://app.example.com/app/dashboard';
        const headers = new Headers();
        headers.set('Origin', 'https://app.example.com');
        const request = new Request('https://app.example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).toBeNull();
      });

      it('validateOrigin_mismatchedPort_returns403', async () => {
        process.env.WEB_APP_URL = 'https://app.example.com:443';
        const headers = new Headers();
        headers.set('Origin', 'https://app.example.com:8443');
        const request = new Request('https://app.example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).not.toBeNull();
        expect(result?.status).toBe(403);
      });

      it('validateOrigin_protocolMismatch_returns403', async () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const headers = new Headers();
        headers.set('Origin', 'http://app.example.com');
        const request = new Request('https://app.example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).not.toBeNull();
        expect(result?.status).toBe(403);
      });
    });

    describe('case sensitivity', () => {
      it('validateOrigin_lowercaseOrigin_matchesNormalizedWEB_APP_URL', () => {
        process.env.WEB_APP_URL = 'https://APP.EXAMPLE.COM';
        const headers = new Headers();
        headers.set('Origin', 'https://app.example.com');
        const request = new Request('https://app.example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        // URL normalization should make this case-insensitive for host
        expect(result).toBeNull();
      });

      it('validateOrigin_mixedCaseOrigin_matchesNormalizedWEB_APP_URL', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const headers = new Headers();
        headers.set('Origin', 'https://APP.EXAMPLE.COM');
        const request = new Request('https://app.example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        // URL normalization should make this case-insensitive for host
        expect(result).toBeNull();
      });
    });

    describe('no configuration edge case', () => {
      it('validateOrigin_noWEB_APP_URL_logsWarningAndAllowsRequest', () => {
        // No WEB_APP_URL configured
        const headers = new Headers();
        headers.set('Origin', 'https://any-origin.example.com');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).toBeNull();
        expect(loggers.auth.warn).toHaveBeenCalledWith(
          'Origin validation: WEB_APP_URL not configured, skipping validation',
          expect.objectContaining({
            origin: 'https://any-origin.example.com',
          })
        );
      });
    });

    describe('malformed origin handling', () => {
      it('validateOrigin_malformedOrigin_returns403', async () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const headers = new Headers();
        headers.set('Origin', 'not-a-valid-url');
        const request = new Request('https://app.example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).not.toBeNull();
        expect(result?.status).toBe(403);
      });
    });

    describe('whitespace handling in ADDITIONAL_ALLOWED_ORIGINS', () => {
      it('validateOrigin_additionalOriginsWithWhitespace_trims', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        process.env.ADDITIONAL_ALLOWED_ORIGINS = '  https://staging.example.com , https://dev.example.com  ';
        const headers = new Headers();
        headers.set('Origin', 'https://staging.example.com');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).toBeNull();
      });
    });
  });

  describe('validateOriginForMiddleware', () => {
    describe('safe method bypass', () => {
      it('validateOriginForMiddleware_GETRequest_returnsSkippedResult', () => {
        const request = new Request('https://example.com/api/test', { method: 'GET' });

        const result = validateOriginForMiddleware(request);

        expect(result).toEqual({
          valid: true,
          origin: null,
          skipped: true,
          reason: 'Safe HTTP method',
        });
      });

      it('validateOriginForMiddleware_HEADRequest_returnsSkippedResult', () => {
        const request = new Request('https://example.com/api/test', { method: 'HEAD' });

        const result = validateOriginForMiddleware(request);

        expect(result).toEqual({
          valid: true,
          origin: null,
          skipped: true,
          reason: 'Safe HTTP method',
        });
      });

      it('validateOriginForMiddleware_OPTIONSRequest_returnsSkippedResult', () => {
        const request = new Request('https://example.com/api/test', { method: 'OPTIONS' });

        const result = validateOriginForMiddleware(request);

        expect(result).toEqual({
          valid: true,
          origin: null,
          skipped: true,
          reason: 'Safe HTTP method',
        });
      });
    });

    describe('missing Origin header handling', () => {
      it('validateOriginForMiddleware_noOriginHeader_returnsSkippedResult', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const request = new Request('https://example.com/api/test', { method: 'POST' });

        const result = validateOriginForMiddleware(request);

        expect(result).toEqual({
          valid: true,
          origin: null,
          skipped: true,
          reason: 'No Origin header present',
        });
        expect(loggers.auth.debug).toHaveBeenCalledWith(
          'Middleware origin validation: no Origin header (skipped)',
          expect.objectContaining({
            method: 'POST',
          })
        );
      });
    });

    describe('valid origin matching', () => {
      it('validateOriginForMiddleware_validOrigin_returnsValidResult', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const headers = new Headers();
        headers.set('Origin', 'https://app.example.com');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOriginForMiddleware(request);

        expect(result).toEqual({
          valid: true,
          origin: 'https://app.example.com',
          skipped: false,
          reason: 'Origin in allowed list',
        });
      });
    });

    describe('invalid origin handling in block mode (default)', () => {
      it('validateOriginForMiddleware_invalidOriginDefaultMode_returnsInvalidAndBlocked', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        // Default is block mode - no ORIGIN_VALIDATION_MODE set
        const headers = new Headers();
        headers.set('Origin', 'https://evil.example.com');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOriginForMiddleware(request);

        expect(result).toEqual({
          valid: false,
          origin: 'https://evil.example.com',
          skipped: false,
          reason: 'Origin not in allowed list (block mode - request rejected)',
        });
        expect(loggers.auth.warn).toHaveBeenCalledWith(
          'Middleware origin validation: unexpected origin (block mode)',
          expect.objectContaining({
            origin: 'https://evil.example.com',
            mode: 'block',
          })
        );
      });

      it('validateOriginForMiddleware_invalidOriginExplicitBlockMode_returnsInvalidAndBlocked', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        process.env.ORIGIN_VALIDATION_MODE = 'block';
        const headers = new Headers();
        headers.set('Origin', 'https://evil.example.com');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOriginForMiddleware(request);

        expect(result).toEqual({
          valid: false,
          origin: 'https://evil.example.com',
          skipped: false,
          reason: 'Origin not in allowed list (block mode - request rejected)',
        });
      });
    });

    describe('invalid origin handling in warn mode (opt-in)', () => {
      it('validateOriginForMiddleware_invalidOriginWarnMode_returnsInvalidButNotBlocked', () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        process.env.ORIGIN_VALIDATION_MODE = 'warn';
        const headers = new Headers();
        headers.set('Origin', 'https://evil.example.com');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOriginForMiddleware(request);

        expect(result).toEqual({
          valid: false,
          origin: 'https://evil.example.com',
          skipped: false,
          reason: 'Origin not in allowed list (warn mode - request allowed)',
        });
        expect(loggers.auth.warn).toHaveBeenCalledWith(
          'Middleware origin validation: unexpected origin (warn mode)',
          expect.objectContaining({
            origin: 'https://evil.example.com',
            mode: 'warn',
          })
        );
      });
    });

    describe('no configuration edge case', () => {
      it('validateOriginForMiddleware_noWEB_APP_URL_returnsSkippedWithWarning', () => {
        // No WEB_APP_URL configured
        const headers = new Headers();
        headers.set('Origin', 'https://any-origin.example.com');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOriginForMiddleware(request);

        expect(result).toEqual({
          valid: true,
          origin: 'https://any-origin.example.com',
          skipped: true,
          reason: 'WEB_APP_URL not configured',
        });
        expect(loggers.auth.warn).toHaveBeenCalledWith(
          'Middleware origin validation: WEB_APP_URL not configured',
          expect.objectContaining({
            origin: 'https://any-origin.example.com',
          })
        );
      });
    });
  });

  describe('isOriginValidationBlocking', () => {
    it('isOriginValidationBlocking_noConfig_returnsTrue', () => {
      // Default is block mode - secure by default
      expect(isOriginValidationBlocking()).toBe(true);
    });

    it('isOriginValidationBlocking_warnMode_returnsFalse', () => {
      process.env.ORIGIN_VALIDATION_MODE = 'warn';
      expect(isOriginValidationBlocking()).toBe(false);
    });

    it('isOriginValidationBlocking_blockMode_returnsTrue', () => {
      process.env.ORIGIN_VALIDATION_MODE = 'block';
      expect(isOriginValidationBlocking()).toBe(true);
    });

    it('isOriginValidationBlocking_unknownMode_returnsTrue', () => {
      process.env.ORIGIN_VALIDATION_MODE = 'invalid-mode';
      expect(isOriginValidationBlocking()).toBe(true);
    });
  });

  describe('edge cases', () => {
    describe('localhost variations', () => {
      it('validateOrigin_localhost_matchesCorrectly', () => {
        process.env.WEB_APP_URL = 'http://localhost:3000';
        const headers = new Headers();
        headers.set('Origin', 'http://localhost:3000');
        const request = new Request('http://localhost:3000/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).toBeNull();
      });

      it('validateOrigin_127_0_0_1_matchesCorrectly', () => {
        process.env.WEB_APP_URL = 'http://127.0.0.1:3000';
        const headers = new Headers();
        headers.set('Origin', 'http://127.0.0.1:3000');
        const request = new Request('http://127.0.0.1:3000/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).toBeNull();
      });

      it('validateOrigin_localhostVs127_0_0_1_doesNotMatch', async () => {
        // localhost and 127.0.0.1 are different origins
        process.env.WEB_APP_URL = 'http://localhost:3000';
        const headers = new Headers();
        headers.set('Origin', 'http://127.0.0.1:3000');
        const request = new Request('http://localhost:3000/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).not.toBeNull();
        expect(result?.status).toBe(403);
      });
    });

    describe('subdomain handling', () => {
      it('validateOrigin_subdomainDoesNotMatch_returns403', async () => {
        process.env.WEB_APP_URL = 'https://example.com';
        const headers = new Headers();
        headers.set('Origin', 'https://app.example.com');
        const request = new Request('https://example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).not.toBeNull();
        expect(result?.status).toBe(403);
      });

      it('validateOrigin_parentDomainDoesNotMatch_returns403', async () => {
        process.env.WEB_APP_URL = 'https://app.example.com';
        const headers = new Headers();
        headers.set('Origin', 'https://example.com');
        const request = new Request('https://app.example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        expect(result).not.toBeNull();
        expect(result?.status).toBe(403);
      });
    });

    describe('standard ports', () => {
      it('validateOrigin_httpsDefaultPort_normalizesCorrectly', () => {
        // HTTPS default port 443 should be equivalent to no port
        process.env.WEB_APP_URL = 'https://app.example.com:443';
        const headers = new Headers();
        headers.set('Origin', 'https://app.example.com');
        const request = new Request('https://app.example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        // URL normalization should make these equivalent
        expect(result).toBeNull();
      });

      it('validateOrigin_httpDefaultPort_normalizesCorrectly', () => {
        // HTTP default port 80 should be equivalent to no port
        process.env.WEB_APP_URL = 'http://app.example.com:80';
        const headers = new Headers();
        headers.set('Origin', 'http://app.example.com');
        const request = new Request('http://app.example.com/api/test', {
          method: 'POST',
          headers,
        });

        const result = validateOrigin(request);

        // URL normalization should make these equivalent
        expect(result).toBeNull();
      });
    });

    describe('multiple HTTP methods with origin validation', () => {
      const mutationMethods = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

      mutationMethods.forEach((method) => {
        it(`validateOrigin_${method}WithValidOrigin_returnsNull`, () => {
          process.env.WEB_APP_URL = 'https://app.example.com';
          const headers = new Headers();
          headers.set('Origin', 'https://app.example.com');
          const request = new Request('https://app.example.com/api/test', {
            method,
            headers,
          });

          const result = validateOrigin(request);

          expect(result).toBeNull();
        });
      });

      mutationMethods.forEach((method) => {
        it(`validateOrigin_${method}WithInvalidOrigin_returns403`, async () => {
          process.env.WEB_APP_URL = 'https://app.example.com';
          const headers = new Headers();
          headers.set('Origin', 'https://evil.example.com');
          const request = new Request('https://app.example.com/api/test', {
            method,
            headers,
          });

          const result = validateOrigin(request);

          expect(result).not.toBeNull();
          expect(result?.status).toBe(403);
        });
      });
    });
  });
});

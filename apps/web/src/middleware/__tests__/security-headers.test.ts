/**
 * Tests for security headers middleware
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import {
  generateNonce,
  buildCSPPolicy,
  buildAPICSPPolicy,
  applySecurityHeaders,
  createSecureResponse,
  NONCE_HEADER,
} from '../security-headers';

vi.mock('next/server', () => ({
  NextResponse: {
    next: vi.fn(() => ({
      headers: new Map(),
    })),
  },
}));

describe('Security Headers', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset the mock to return a fresh response with Map-based headers
    vi.mocked(NextResponse.next).mockImplementation(() => {
      const headersMap = new Map<string, string>();
      return {
        headers: {
          set: (key: string, value: string) => headersMap.set(key, value),
          get: (key: string) => headersMap.get(key),
          has: (key: string) => headersMap.has(key),
        },
      } as unknown as NextResponse;
    });
  });

  describe('generateNonce', () => {
    it('generates unique nonces per call', () => {
      const nonce1 = generateNonce();
      const nonce2 = generateNonce();

      expect(nonce1).not.toBe(nonce2);
    });

    it('generates base64 encoded nonces', () => {
      const nonce = generateNonce();

      // Base64 pattern: alphanumeric, +, /, and = padding
      expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it('generates nonces of consistent format', () => {
      const nonce = generateNonce();

      // UUID base64 encoded should be ~48 chars
      expect(nonce.length).toBeGreaterThan(20);
      expect(nonce.length).toBeLessThan(60);
    });
  });

  describe('buildCSPPolicy', () => {
    it('includes nonce in script-src', () => {
      const nonce = 'test-nonce-123';
      const csp = buildCSPPolicy(nonce);

      expect(csp).toContain(`'nonce-${nonce}'`);
    });

    it('includes strict-dynamic in script-src', () => {
      const csp = buildCSPPolicy('test-nonce');

      expect(csp).toContain("'strict-dynamic'");
    });

    it('sets frame-ancestors to none', () => {
      const csp = buildCSPPolicy('test-nonce');

      expect(csp).toContain("frame-ancestors 'none'");
    });

    it('includes base-uri self for base tag protection', () => {
      const csp = buildCSPPolicy('test-nonce');

      expect(csp).toContain("base-uri 'self'");
    });

    it('includes form-action self for form protection', () => {
      const csp = buildCSPPolicy('test-nonce');

      expect(csp).toContain("form-action 'self'");
    });

    it('includes unsafe-inline fallback for older browsers', () => {
      const csp = buildCSPPolicy('test-nonce');

      // unsafe-inline is ignored when strict-dynamic is present
      // but included for backwards compatibility
      expect(csp).toContain("'unsafe-inline'");
    });

    it('allows websocket connections', () => {
      const csp = buildCSPPolicy('test-nonce');

      expect(csp).toContain('ws:');
      expect(csp).toContain('wss:');
    });
  });

  describe('buildAPICSPPolicy', () => {
    it('has restrictive default-src none', () => {
      const csp = buildAPICSPPolicy();

      expect(csp).toContain("default-src 'none'");
    });

    it('sets frame-ancestors to none', () => {
      const csp = buildAPICSPPolicy();

      expect(csp).toContain("frame-ancestors 'none'");
    });

    it('does not include nonce (not needed for API responses)', () => {
      const csp = buildAPICSPPolicy();

      expect(csp).not.toContain('nonce-');
    });
  });

  describe('applySecurityHeaders', () => {
    it('sets CSP header on response', () => {
      const response = NextResponse.next();
      const nonce = 'test-nonce';

      applySecurityHeaders(response, { nonce, isProduction: false });

      expect(response.headers.get('Content-Security-Policy')).toContain(
        `'nonce-${nonce}'`
      );
    });

    it('sets X-Frame-Options to DENY', () => {
      const response = NextResponse.next();

      applySecurityHeaders(response, { nonce: 'test', isProduction: false });

      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    });

    it('sets X-Content-Type-Options to nosniff', () => {
      const response = NextResponse.next();

      applySecurityHeaders(response, { nonce: 'test', isProduction: false });

      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('sets Referrer-Policy', () => {
      const response = NextResponse.next();

      applySecurityHeaders(response, { nonce: 'test', isProduction: false });

      expect(response.headers.get('Referrer-Policy')).toBe(
        'strict-origin-when-cross-origin'
      );
    });

    it('sets Permissions-Policy', () => {
      const response = NextResponse.next();

      applySecurityHeaders(response, { nonce: 'test', isProduction: false });

      expect(response.headers.get('Permissions-Policy')).toBe(
        'geolocation=(), microphone=(), camera=()'
      );
    });

    it('sets HSTS header in production', () => {
      const response = NextResponse.next();

      applySecurityHeaders(response, { nonce: 'test', isProduction: true });

      expect(response.headers.get('Strict-Transport-Security')).toBe(
        'max-age=63072000; includeSubDomains; preload'
      );
    });

    it('does not set HSTS header in development', () => {
      const response = NextResponse.next();

      applySecurityHeaders(response, { nonce: 'test', isProduction: false });

      expect(response.headers.has('Strict-Transport-Security')).toBe(false);
    });

    it('uses API CSP policy for API routes', () => {
      const response = NextResponse.next();

      applySecurityHeaders(response, {
        nonce: 'test',
        isProduction: false,
        isAPIRoute: true,
      });

      const csp = response.headers.get('Content-Security-Policy');
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('nonce-');
    });
  });

  describe('createSecureResponse', () => {
    it('returns response with nonce header', () => {
      const { response, nonce } = createSecureResponse(false);

      expect(response.headers.get(NONCE_HEADER)).toBe(nonce);
    });

    it('returns response with security headers applied', () => {
      const { response } = createSecureResponse(false);

      expect(response.headers.has('Content-Security-Policy')).toBe(true);
      expect(response.headers.has('X-Frame-Options')).toBe(true);
    });

    it('returns unique nonce on each call', () => {
      const { nonce: nonce1 } = createSecureResponse(false);
      const { nonce: nonce2 } = createSecureResponse(false);

      expect(nonce1).not.toBe(nonce2);
    });
  });
});

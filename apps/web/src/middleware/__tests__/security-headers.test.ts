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
  createSecureErrorResponse,
  NONCE_HEADER,
} from '../security-headers';

vi.mock('next/server', () => {
  // Create a class-like constructor for NextResponse
  const MockNextResponse = vi.fn((body?: string | null, init?: ResponseInit) => {
    const headers = new Map<string, string>();
    if (init?.headers) {
      Object.entries(init.headers).forEach(([key, value]) => {
        headers.set(key, value as string);
      });
    }
    return {
      status: init?.status ?? 200,
      headers: {
        set: (key: string, value: string) => headers.set(key, value),
        get: (key: string) => headers.get(key) ?? null,
        has: (key: string) => headers.has(key),
      },
    };
  }) as unknown as typeof NextResponse;

  // Add static methods
  (MockNextResponse as { next: typeof NextResponse.next }).next = vi.fn(() => ({
    headers: new Map(),
  })) as unknown as typeof NextResponse.next;

  return { NextResponse: MockNextResponse };
});

describe('Security Headers', () => {
  let lastRequestHeaders: Headers | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    lastRequestHeaders = undefined;

    // Reset the mock to return a fresh response with Map-based headers
    // and capture request headers passed via options
    vi.mocked(NextResponse.next).mockImplementation((options?: { request?: { headers?: Headers } }) => {
      lastRequestHeaders = options?.request?.headers;
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

  // Helper to get the last request headers passed to NextResponse.next()
  const getLastRequestHeaders = () => lastRequestHeaders;

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

    it('allows Google accounts domain for One Tap authentication', () => {
      const csp = buildCSPPolicy('test-nonce');

      expect(csp).toContain('https://accounts.google.com');
    });

    it('allows Google accounts and Stripe iframes via frame-src', () => {
      const csp = buildCSPPolicy('test-nonce');

      expect(csp).toContain('frame-src https://accounts.google.com https://js.stripe.com');
    });

    it('blocks plugins via object-src none', () => {
      const csp = buildCSPPolicy('test-nonce');

      expect(csp).toContain("object-src 'none'");
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

    it('does not set Cross-Origin-Embedder-Policy (removed for Stripe.js compatibility)', () => {
      const response = NextResponse.next();

      applySecurityHeaders(response, { nonce: 'test', isProduction: false });

      expect(response.headers.has('Cross-Origin-Embedder-Policy')).toBe(false);
    });
  });

  describe('createSecureResponse', () => {
    it('passes nonce to request headers for layout access', () => {
      const { nonce } = createSecureResponse(false);

      const requestHeaders = getLastRequestHeaders();
      expect(requestHeaders?.get(NONCE_HEADER)).toBe(nonce);
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

    it('clones existing request headers when provided', () => {
      const mockRequest = new Request('https://example.com', {
        headers: { 'x-custom-header': 'test-value' },
      });
      createSecureResponse(false, mockRequest);

      const requestHeaders = getLastRequestHeaders();
      expect(requestHeaders?.get('x-custom-header')).toBe('test-value');
    });

    it('uses API CSP policy when isAPIRoute is true', () => {
      const { response } = createSecureResponse(false, undefined, true);

      const csp = response.headers.get('Content-Security-Policy');
      expect(csp).toContain("default-src 'none'");
      expect(csp).not.toContain('nonce-');
    });

    it('sets CSP in request headers for Next.js SSR nonce parsing', () => {
      const { nonce } = createSecureResponse(false);

      const requestHeaders = getLastRequestHeaders();
      const csp = requestHeaders?.get('Content-Security-Policy');
      expect(csp).toContain(`'nonce-${nonce}'`);
      expect(csp).toContain("'strict-dynamic'");
    });

    it('does not set CSP in request headers for API routes', () => {
      createSecureResponse(false, undefined, true);

      const requestHeaders = getLastRequestHeaders();
      expect(requestHeaders?.get('Content-Security-Policy')).toBeNull();
    });
  });

  describe('createSecureErrorResponse', () => {
    it('returns response with correct status code', () => {
      const response = createSecureErrorResponse('Error', 401);

      expect(response.status).toBe(401);
    });

    it('returns JSON response for object body', () => {
      const response = createSecureErrorResponse({ error: 'Not allowed' }, 403);

      expect(response.headers.get('Content-Type')).toBe('application/json');
    });

    it('returns text response for string body', () => {
      const response = createSecureErrorResponse('Error message', 401);

      expect(response.headers.get('Content-Type')).toBe('text/plain');
    });

    it('includes security headers', () => {
      const response = createSecureErrorResponse('Error', 500);

      expect(response.headers.get('Content-Security-Policy')).toContain(
        "default-src 'none'"
      );
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('Referrer-Policy')).toBe(
        'strict-origin-when-cross-origin'
      );
    });

    it('includes HSTS in production', () => {
      const response = createSecureErrorResponse('Error', 500, true);

      expect(response.headers.get('Strict-Transport-Security')).toBe(
        'max-age=63072000; includeSubDomains; preload'
      );
    });

    it('excludes HSTS in development', () => {
      const response = createSecureErrorResponse('Error', 500, false);

      expect(response.headers.get('Strict-Transport-Security')).toBeNull();
    });
  });
});

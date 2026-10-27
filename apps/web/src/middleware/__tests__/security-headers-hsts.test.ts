/**
 * HSTS transit-encryption hardening (GDPR #969, Phase 5).
 *
 * The old behavior gated HSTS solely on NODE_ENV==='production', so any
 * HTTPS-served environment that is not literally production (staging, tenant,
 * preview) shipped no HSTS — an encryption-in-transit downgrade gap. HSTS must
 * be emitted for ANY HTTPS response, while plain-http dev (localhost) stays
 * clean.
 */
import { describe, it, expect, vi } from 'vitest';
import { NextResponse } from 'next/server';
import {
  shouldEmitHsts,
  isSecureRequest,
  applySecurityHeaders,
  createSecureErrorResponse,
} from '../security-headers';

vi.mock('next/server', () => {
  const MockNextResponse = vi.fn((body?: string | null, init?: ResponseInit) => {
    const headers = new Map<string, string>();
    if (init?.headers) {
      Object.entries(init.headers).forEach(([k, v]) => headers.set(k, v as string));
    }
    return {
      status: init?.status ?? 200,
      headers: {
        set: (k: string, v: string) => headers.set(k, v),
        get: (k: string) => headers.get(k) ?? null,
        has: (k: string) => headers.has(k),
      },
    };
  }) as unknown as typeof NextResponse;
  (MockNextResponse as { next: typeof NextResponse.next }).next = vi.fn(() => {
    const headers = new Map<string, string>();
    return {
      headers: {
        set: (k: string, v: string) => headers.set(k, v),
        get: (k: string) => headers.get(k) ?? null,
        has: (k: string) => headers.has(k),
      },
    };
  }) as unknown as typeof NextResponse.next;
  return { NextResponse: MockNextResponse };
});

const HSTS = 'max-age=63072000; includeSubDomains; preload';

describe('shouldEmitHsts (pure)', () => {
  it('given a secure (https) request, should emit HSTS even when not production', () => {
    expect(shouldEmitHsts({ isProduction: false, isSecure: true })).toBe(true);
  });

  it('given production, should emit HSTS regardless of scheme (back-compat)', () => {
    expect(shouldEmitHsts({ isProduction: true, isSecure: false })).toBe(true);
  });

  it('given non-production plain http (dev), should NOT emit HSTS', () => {
    expect(shouldEmitHsts({ isProduction: false, isSecure: false })).toBe(false);
  });
});

describe('isSecureRequest (pure)', () => {
  it('given x-forwarded-proto https, should be secure', () => {
    const req = new Request('http://internal/x', { headers: { 'x-forwarded-proto': 'https' } });
    expect(isSecureRequest(req)).toBe(true);
  });

  it('given an https:// url, should be secure', () => {
    expect(isSecureRequest(new Request('https://app.example.com/x'))).toBe(true);
  });

  it('given plain http with no forwarded proto, should not be secure', () => {
    expect(isSecureRequest(new Request('http://localhost:3000/x'))).toBe(false);
  });
});

describe('applySecurityHeaders HSTS by scheme', () => {
  it('given a secure non-production response, should set HSTS', () => {
    const res = NextResponse.next();
    applySecurityHeaders(res, { nonce: 't', isProduction: false, isSecure: true });
    expect(res.headers.get('Strict-Transport-Security')).toBe(HSTS);
  });

  it('given insecure dev response, should not set HSTS', () => {
    const res = NextResponse.next();
    applySecurityHeaders(res, { nonce: 't', isProduction: false, isSecure: false });
    expect(res.headers.has('Strict-Transport-Security')).toBe(false);
  });
});

describe('createSecureErrorResponse HSTS by scheme', () => {
  it('given a secure non-production error, should set HSTS', () => {
    const res = createSecureErrorResponse('nope', 401, false, true);
    expect(res.headers.get('Strict-Transport-Security')).toBe(HSTS);
  });
});

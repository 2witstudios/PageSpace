import { describe, it, expect, vi } from 'vitest';

// Mock all runtime dependencies so the static `config` export can be imported
vi.mock('@/lib/logging/edge-logger', () => ({
  logSecurityEvent: vi.fn(),
  createEdgeLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })),
}));
vi.mock('@/middleware/monitoring', () => ({ monitoringMiddleware: vi.fn() }));
vi.mock('@/middleware/security-headers', () => ({
  createSecureResponse: vi.fn(),
  createSecureErrorResponse: vi.fn(),
  isPublicPageRoute: vi.fn(),
  isPublishedSiteHost: vi.fn(),
  shouldDisableCOEP: vi.fn(),
}));
// middleware.ts imports origin validation from its leaf module (never the
// Node-only '@/lib/auth' barrel), so that's what gets mocked. The bearer
// prefixes load from the real '@/lib/auth/token-prefixes' leaf: it's pure and
// edge-safe, and mocking it would just recreate the drift it exists to prevent.
vi.mock('@/lib/auth/origin-validation', () => ({
  validateOriginForMiddleware: vi.fn(),
  isOriginValidationBlocking: vi.fn(),
}));
vi.mock('@/lib/auth/cookie-config', () => ({ getSessionFromCookies: vi.fn() }));

// Import the live config so this test fails (RED) until middleware.ts is updated
const { config } = await import('../../middleware');
const PATTERN = config.matcher[0].source;

describe('middleware matcher', () => {
  // Next.js anchors the source pattern against the full pathname — mirror that here.
  function matches(pattern: string, path: string): boolean {
    return new RegExp(`^${pattern}$`).test(path);
  }

  it('excludes /sentry-tunnel', () => {
    expect(matches(PATTERN, '/sentry-tunnel')).toBe(false);
  });

  it('excludes /_next/static paths', () => {
    expect(matches(PATTERN, '/_next/static/chunks/main.js')).toBe(false);
  });

  it('matches /dashboard routes', () => {
    expect(matches(PATTERN, '/dashboard/123')).toBe(true);
  });

  it('matches /api routes', () => {
    expect(matches(PATTERN, '/api/health')).toBe(true);
  });
});

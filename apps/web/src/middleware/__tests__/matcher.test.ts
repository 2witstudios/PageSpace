import { describe, it, expect, vi } from 'vitest';

// Mock all runtime dependencies so the static `config` export can be imported
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  logSecurityEvent: vi.fn(),
  logger: { child: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() })) },
}));
vi.mock('@/middleware/monitoring', () => ({ monitoringMiddleware: vi.fn() }));
vi.mock('@/middleware/security-headers', () => ({
  createSecureResponse: vi.fn(),
  createSecureErrorResponse: vi.fn(),
  isPublicPageRoute: vi.fn(),
  isPublishedSiteHost: vi.fn(),
  shouldDisableCOEP: vi.fn(),
}));
vi.mock('@/lib/auth', () => ({
  validateOriginForMiddleware: vi.fn(),
  isOriginValidationBlocking: vi.fn(),
  MCP_TOKEN_PREFIX: 'mcp_',
  SESSION_TOKEN_PREFIX: 'ps_sess_',
  OAUTH_ACCESS_TOKEN_PREFIX: 'ps_at_',
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

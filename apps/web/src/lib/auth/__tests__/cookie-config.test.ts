import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  COOKIE_CONFIG,
  createAccessTokenCookie,
  createRefreshTokenCookie,
  createClearAccessTokenCookie,
  createClearRefreshTokenCookie,
  createClearLegacyRefreshTokenCookie,
  createClearCookies,
  appendAuthCookies,
  appendClearCookies,
} from '../cookie-config';

// Mock getRefreshTokenMaxAge
vi.mock('@pagespace/lib/server', () => ({
  getRefreshTokenMaxAge: () => 30 * 24 * 60 * 60, // 30 days
}));

describe('cookie-config', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalCookieDomain = process.env.COOKIE_DOMAIN;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'test');
    delete process.env.COOKIE_DOMAIN;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    // Restore original values
    if (originalNodeEnv !== undefined) {
      vi.stubEnv('NODE_ENV', originalNodeEnv);
    }
    if (originalCookieDomain !== undefined) {
      process.env.COOKIE_DOMAIN = originalCookieDomain;
    }
  });

  describe('COOKIE_CONFIG', () => {
    it('should have correct access token configuration', () => {
      expect(COOKIE_CONFIG.accessToken.name).toBe('accessToken');
      expect(COOKIE_CONFIG.accessToken.maxAge).toBe(15 * 60);
      expect(COOKIE_CONFIG.accessToken.path).toBe('/');
    });

    it('should have refresh token scoped to /api/auth', () => {
      expect(COOKIE_CONFIG.refreshToken.name).toBe('refreshToken');
      expect(COOKIE_CONFIG.refreshToken.path).toBe('/api/auth');
    });

    it('should have legacy path as "/" for migration', () => {
      expect(COOKIE_CONFIG.legacyRefreshTokenPath).toBe('/');
    });
  });

  describe('createAccessTokenCookie', () => {
    it('should create cookie with httpOnly flag', () => {
      const cookie = createAccessTokenCookie('test-token');
      expect(cookie).toContain('HttpOnly');
    });

    it('should create cookie with sameSite strict', () => {
      const cookie = createAccessTokenCookie('test-token');
      expect(cookie).toContain('SameSite=Strict');
    });

    it('should create cookie with path /', () => {
      const cookie = createAccessTokenCookie('test-token');
      expect(cookie).toContain('Path=/;');
    });

    it('should create cookie with 15 minute maxAge', () => {
      const cookie = createAccessTokenCookie('test-token');
      expect(cookie).toContain(`Max-Age=${15 * 60}`);
    });

    it('should not include secure flag in non-production', () => {
      vi.stubEnv('NODE_ENV', 'test');
      const cookie = createAccessTokenCookie('test-token');
      expect(cookie).not.toContain('Secure');
    });

    it('should include secure flag in production', () => {
      vi.stubEnv('NODE_ENV', 'production');
      const cookie = createAccessTokenCookie('test-token');
      expect(cookie).toContain('Secure');
    });

    it('should include domain in production when COOKIE_DOMAIN is set', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('COOKIE_DOMAIN', '.example.com');
      const cookie = createAccessTokenCookie('test-token');
      expect(cookie).toContain('Domain=.example.com');
    });
  });

  describe('createRefreshTokenCookie', () => {
    it('should create cookie with httpOnly flag', () => {
      const cookie = createRefreshTokenCookie('test-token');
      expect(cookie).toContain('HttpOnly');
    });

    it('should create cookie with sameSite strict', () => {
      const cookie = createRefreshTokenCookie('test-token');
      expect(cookie).toContain('SameSite=Strict');
    });

    it('should create cookie with scoped path /api/auth', () => {
      const cookie = createRefreshTokenCookie('test-token');
      expect(cookie).toContain('Path=/api/auth');
    });

    it('should create cookie with 30 day maxAge', () => {
      const cookie = createRefreshTokenCookie('test-token');
      expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    });
  });

  describe('createClearAccessTokenCookie', () => {
    it('should create cookie that expires token', () => {
      const cookie = createClearAccessTokenCookie();
      expect(cookie).toContain('accessToken=;');
      expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
    });

    it('should maintain security flags when clearing', () => {
      const cookie = createClearAccessTokenCookie();
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
    });
  });

  describe('createClearRefreshTokenCookie', () => {
    it('should create cookie that expires token with scoped path', () => {
      const cookie = createClearRefreshTokenCookie();
      expect(cookie).toContain('refreshToken=;');
      expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
      expect(cookie).toContain('Path=/api/auth');
    });
  });

  describe('createClearLegacyRefreshTokenCookie', () => {
    it('should create cookie that expires token with legacy path /', () => {
      const cookie = createClearLegacyRefreshTokenCookie();
      expect(cookie).toContain('refreshToken=;');
      expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
      expect(cookie).toContain('Path=/;');
    });
  });

  describe('createClearCookies', () => {
    it('should return all clear cookies', () => {
      const cookies = createClearCookies();
      expect(cookies.accessToken).toContain('accessToken=;');
      expect(cookies.refreshToken).toContain('refreshToken=;');
      expect(cookies.legacyRefreshToken).toContain('refreshToken=;');
    });

    it('should have refresh and legacy cookies with different paths', () => {
      const cookies = createClearCookies();
      expect(cookies.refreshToken).toContain('Path=/api/auth');
      expect(cookies.legacyRefreshToken).toContain('Path=/;');
    });
  });

  describe('appendAuthCookies', () => {
    it('should append access, refresh, and legacy clear cookies', () => {
      const headers = new Headers();
      appendAuthCookies(headers, 'access-token', 'refresh-token');

      const setCookieHeaders = headers.getSetCookie();
      expect(setCookieHeaders).toHaveLength(3);
      expect(setCookieHeaders[0]).toContain('accessToken=access-token');
      expect(setCookieHeaders[1]).toContain('refreshToken=refresh-token');
      // Third cookie clears legacy
      expect(setCookieHeaders[2]).toContain('refreshToken=;');
      expect(setCookieHeaders[2]).toContain('Path=/;');
    });
  });

  describe('appendClearCookies', () => {
    it('should append all clear cookies for logout', () => {
      const headers = new Headers();
      appendClearCookies(headers);

      const setCookieHeaders = headers.getSetCookie();
      expect(setCookieHeaders).toHaveLength(3);

      // Verify all cookies are expired
      setCookieHeaders.forEach((cookie) => {
        expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
      });
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  COOKIE_CONFIG,
  createSessionCookie,
  createClearSessionCookie,
  appendSessionCookie,
  appendClearCookies,
  getSessionFromCookies,
} from '../cookie-config';

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
    if (originalNodeEnv !== undefined) {
      vi.stubEnv('NODE_ENV', originalNodeEnv);
    }
    if (originalCookieDomain !== undefined) {
      process.env.COOKIE_DOMAIN = originalCookieDomain;
    }
  });

  describe('COOKIE_CONFIG', () => {
    it('should have correct session configuration', () => {
      expect(COOKIE_CONFIG.session.name).toBe('session');
      expect(COOKIE_CONFIG.session.maxAge).toBe(7 * 24 * 60 * 60); // 7 days
      expect(COOKIE_CONFIG.session.path).toBe('/');
    });
  });

  describe('createSessionCookie', () => {
    it('should create cookie with httpOnly flag', () => {
      const cookie = createSessionCookie('ps_sess_test123');
      expect(cookie).toContain('HttpOnly');
    });

    it('should create cookie with sameSite strict', () => {
      const cookie = createSessionCookie('ps_sess_test123');
      expect(cookie).toContain('SameSite=Strict');
    });

    it('should create cookie with path /', () => {
      const cookie = createSessionCookie('ps_sess_test123');
      expect(cookie).toContain('Path=/');
    });

    it('should create cookie with 7 day maxAge', () => {
      const cookie = createSessionCookie('ps_sess_test123');
      expect(cookie).toContain(`Max-Age=${7 * 24 * 60 * 60}`);
    });

    it('should include session token value', () => {
      const cookie = createSessionCookie('ps_sess_test123');
      expect(cookie).toContain('session=ps_sess_test123');
    });

    it('should not include secure flag in non-production', () => {
      vi.stubEnv('NODE_ENV', 'test');
      const cookie = createSessionCookie('ps_sess_test123');
      expect(cookie).not.toContain('Secure');
    });

    it('should include secure flag in production', () => {
      vi.stubEnv('NODE_ENV', 'production');
      const cookie = createSessionCookie('ps_sess_test123');
      expect(cookie).toContain('Secure');
    });

    it('should include domain in production when COOKIE_DOMAIN is set', () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('COOKIE_DOMAIN', '.example.com');
      const cookie = createSessionCookie('ps_sess_test123');
      expect(cookie).toContain('Domain=.example.com');
    });
  });

  describe('createClearSessionCookie', () => {
    it('should create cookie that expires session', () => {
      const cookie = createClearSessionCookie();
      expect(cookie).toContain('session=;');
      expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
    });

    it('should maintain security flags when clearing', () => {
      const cookie = createClearSessionCookie();
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Strict');
    });

    it('should use root path', () => {
      const cookie = createClearSessionCookie();
      expect(cookie).toContain('Path=/');
    });
  });

  describe('appendSessionCookie', () => {
    it('should append session cookie to headers', () => {
      const headers = new Headers();
      appendSessionCookie(headers, 'ps_sess_test123');

      const setCookieHeaders = headers.getSetCookie();
      const sessionCookie = setCookieHeaders.find((c) => c.startsWith('session=ps_sess'));
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie).toContain('session=ps_sess_test123');
    });

    it('should set only the session cookie', () => {
      const headers = new Headers();
      appendSessionCookie(headers, 'ps_sess_test123');

      const setCookieHeaders = headers.getSetCookie();
      // Should only set the session cookie
      expect(setCookieHeaders.length).toBe(1);
    });
  });

  describe('appendClearCookies', () => {
    it('should append clear session cookie for logout', () => {
      const headers = new Headers();
      appendClearCookies(headers);

      const setCookieHeaders = headers.getSetCookie();
      const sessionClearCookie = setCookieHeaders.find((c) => c.startsWith('session=;'));
      expect(sessionClearCookie).toBeDefined();
      expect(sessionClearCookie).toContain('Expires=Thu, 01 Jan 1970');
    });

    it('should set only the session clear cookie', () => {
      const headers = new Headers();
      appendClearCookies(headers);

      const setCookieHeaders = headers.getSetCookie();
      // Should only clear the session cookie
      expect(setCookieHeaders.length).toBe(1);
    });

    it('should expire the session cookie', () => {
      const headers = new Headers();
      appendClearCookies(headers);

      const setCookieHeaders = headers.getSetCookie();
      setCookieHeaders.forEach((cookie) => {
        expect(cookie).toContain('Expires=Thu, 01 Jan 1970');
      });
    });
  });

  describe('getSessionFromCookies', () => {
    it('should extract session token from cookie header', () => {
      const cookieHeader = 'session=ps_sess_test123; other=value';
      const token = getSessionFromCookies(cookieHeader);
      expect(token).toBe('ps_sess_test123');
    });

    it('should return null when no cookie header', () => {
      const token = getSessionFromCookies(null);
      expect(token).toBeNull();
    });

    it('should return null when session cookie not present', () => {
      const cookieHeader = 'other=value; another=value2';
      const token = getSessionFromCookies(cookieHeader);
      expect(token).toBeNull();
    });

    it('should handle cookie header with multiple cookies', () => {
      const cookieHeader = 'first=1; session=ps_sess_abc; third=3';
      const token = getSessionFromCookies(cookieHeader);
      expect(token).toBe('ps_sess_abc');
    });

    it('should handle cookie header with whitespace', () => {
      const cookieHeader = '  session=ps_sess_test  ;  other=value  ';
      const token = getSessionFromCookies(cookieHeader);
      expect(token).toBe('ps_sess_test');
    });
  });
});

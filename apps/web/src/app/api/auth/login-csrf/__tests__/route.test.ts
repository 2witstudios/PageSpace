import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Contract tests for GET /api/auth/login-csrf
 *
 * This endpoint generates a login CSRF token returned in both the
 * response body and as an httpOnly cookie.
 *
 * Contract:
 *   Request: GET (no authentication required)
 *   Response:
 *     200: { csrfToken: string } with Set-Cookie header
 *
 * Branches:
 *   - NODE_ENV === 'production' vs non-production (secure flag, domain)
 *   - COOKIE_DOMAIN set vs unset in production
 */

vi.mock('@/lib/auth/login-csrf-utils', () => ({
  generateLoginCSRFToken: vi.fn().mockReturnValue('mock-csrf-token.123456.signature'),
  LOGIN_CSRF_COOKIE_NAME: 'login_csrf',
  LOGIN_CSRF_MAX_AGE: 300,
}));

vi.mock('cookie', () => ({
  serialize: vi.fn().mockReturnValue('login_csrf=mock-csrf-token.123456.signature; Path=/api/auth; HttpOnly; SameSite=Strict'),
}));

import { generateLoginCSRFToken, LOGIN_CSRF_COOKIE_NAME, LOGIN_CSRF_MAX_AGE } from '@/lib/auth/login-csrf-utils';
import { serialize } from 'cookie';
import { GET } from '../route';

describe('/api/auth/login-csrf', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv, NODE_ENV: 'test' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('successful token generation', () => {
    it('GET_returns200WithCSRFToken', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/login-csrf', {
        method: 'GET',
      });

      // Act
      const response = await GET();
      const body = await response.json();

      // Assert
      expect(response.status).toBe(200);
      expect(body).toEqual({ csrfToken: 'mock-csrf-token.123456.signature' });
    });

    it('GET_callsGenerateLoginCSRFToken', async () => {
      // Arrange & Act
      await GET();

      // Assert
      expect(generateLoginCSRFToken).toHaveBeenCalledOnce();
    });

    it('GET_setsSetCookieHeader', async () => {
      // Arrange & Act
      const response = await GET();

      // Assert
      expect(response.headers.get('Set-Cookie')).toBe(
        'login_csrf=mock-csrf-token.123456.signature; Path=/api/auth; HttpOnly; SameSite=Strict'
      );
    });

    it('GET_setsCacheControlHeader', async () => {
      // Arrange & Act
      const response = await GET();

      // Assert
      expect(response.headers.get('Cache-Control')).toBe(
        'no-store, no-cache, must-revalidate'
      );
    });
  });

  describe('cookie serialization in non-production', () => {
    it('GET_inNonProduction_serializesWithoutSecureFlag', async () => {
      // Arrange
      process.env.NODE_ENV = 'test';

      // Act
      await GET();

      // Assert
      expect(serialize).toHaveBeenCalledWith(
        LOGIN_CSRF_COOKIE_NAME,
        'mock-csrf-token.123456.signature',
        expect.objectContaining({
          httpOnly: true,
          secure: false,
          sameSite: 'strict',
          maxAge: LOGIN_CSRF_MAX_AGE,
          path: '/api/auth',
        })
      );
    });

    it('GET_inNonProduction_doesNotIncludeDomain', async () => {
      // Arrange
      process.env.NODE_ENV = 'test';
      process.env.COOKIE_DOMAIN = '.example.com';

      // Act
      await GET();

      // Assert: domain should NOT be set in non-production
      const callArgs = vi.mocked(serialize).mock.calls[0][2];
      expect(callArgs).not.toHaveProperty('domain');
    });
  });

  describe('cookie serialization in production', () => {
    it('GET_inProduction_serializesWithSecureFlag', async () => {
      // Arrange
      process.env.NODE_ENV = 'production';

      // Act
      await GET();

      // Assert
      expect(serialize).toHaveBeenCalledWith(
        LOGIN_CSRF_COOKIE_NAME,
        'mock-csrf-token.123456.signature',
        expect.objectContaining({
          httpOnly: true,
          secure: true,
          sameSite: 'strict',
          maxAge: LOGIN_CSRF_MAX_AGE,
          path: '/api/auth',
        })
      );
    });

    it('GET_inProductionWithCookieDomain_includesDomain', async () => {
      // Arrange
      process.env.NODE_ENV = 'production';
      process.env.COOKIE_DOMAIN = '.example.com';

      // Act
      await GET();

      // Assert
      expect(serialize).toHaveBeenCalledWith(
        LOGIN_CSRF_COOKIE_NAME,
        'mock-csrf-token.123456.signature',
        expect.objectContaining({
          domain: '.example.com',
        })
      );
    });

    it('GET_inProductionWithoutCookieDomain_doesNotIncludeDomain', async () => {
      // Arrange
      process.env.NODE_ENV = 'production';
      delete process.env.COOKIE_DOMAIN;

      // Act
      await GET();

      // Assert
      const callArgs = vi.mocked(serialize).mock.calls[0][2];
      expect(callArgs).not.toHaveProperty('domain');
    });
  });
});

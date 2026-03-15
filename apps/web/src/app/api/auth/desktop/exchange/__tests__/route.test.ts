import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Contract tests for POST /api/auth/desktop/exchange
 *
 * Exchanges a one-time code for authentication tokens.
 *
 * Contract:
 *   Request: POST { code: string }
 *   Response:
 *     200: { sessionToken, csrfToken, deviceToken } with Set-Cookie header
 *     400: { error: string } - Missing or invalid code
 *     401: { error: string } - Invalid or expired code
 *     500: { error: string } - Internal error
 *
 * Dependencies mocked at service seam:
 *   - @pagespace/lib/auth: consumeExchangeCode
 *   - @pagespace/lib/server: loggers
 *   - @/lib/auth/cookie-config: createSessionCookie
 *   - zod/v4: schema validation (real implementation)
 */

vi.mock('@pagespace/lib/auth', () => ({
  consumeExchangeCode: vi.fn(),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
  },
}));

vi.mock('@/lib/auth/cookie-config', () => ({
  createSessionCookie: vi.fn().mockReturnValue('session=mock-session-token; Path=/; HttpOnly'),
}));

import { consumeExchangeCode } from '@pagespace/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { createSessionCookie } from '@/lib/auth/cookie-config';
import { POST } from '../route';

describe('/api/auth/desktop/exchange', () => {
  const mockExchangeData = {
    sessionToken: 'ps_sess_mock_session_token',
    csrfToken: 'mock-csrf-token',
    deviceToken: 'mock-device-token',
    provider: 'google',
    userId: 'test-user-id',
    createdAt: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: valid exchange
    vi.mocked(consumeExchangeCode).mockResolvedValue(mockExchangeData);
    vi.mocked(createSessionCookie).mockReturnValue(
      'session=mock-session-token; Path=/; HttpOnly'
    );
  });

  describe('successful exchange', () => {
    it('POST_withValidCode_returns200WithTokens', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'valid-exchange-code' }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(200);
      expect(body).toEqual({
        sessionToken: 'ps_sess_mock_session_token',
        csrfToken: 'mock-csrf-token',
        deviceToken: 'mock-device-token',
      });
    });

    it('POST_withValidCode_setsSessionCookie', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'valid-exchange-code' }),
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(createSessionCookie).toHaveBeenCalledWith('ps_sess_mock_session_token');
      expect(response.headers.get('Set-Cookie')).toBe(
        'session=mock-session-token; Path=/; HttpOnly'
      );
    });

    it('POST_withValidCode_logsSuccessfulExchange', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'valid-exchange-code' }),
      });

      // Act
      await POST(request);

      // Assert
      expect(loggers.auth.info).toHaveBeenCalledWith(
        'Desktop OAuth exchange successful',
        {
          userId: 'test-user-id',
          provider: 'google',
        }
      );
    });

    it('POST_withValidCode_consumesExchangeCode', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'my-one-time-code' }),
      });

      // Act
      await POST(request);

      // Assert
      expect(consumeExchangeCode).toHaveBeenCalledWith('my-one-time-code');
    });
  });

  describe('validation errors (400)', () => {
    it('POST_withMissingCode_returns400', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body).toEqual({ error: 'Missing or invalid exchange code' });
    });

    it('POST_withEmptyCode_returns400', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '' }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body).toEqual({ error: 'Missing or invalid exchange code' });
    });

    it('POST_withInvalidBody_logsWarning', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '' }),
      });

      // Act
      await POST(request);

      // Assert
      expect(loggers.auth.warn).toHaveBeenCalledWith(
        'Invalid exchange request',
        expect.objectContaining({
          errors: expect.any(Array),
        })
      );
    });

    it('POST_withNonStringCode_returns400', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 12345 }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(400);
      expect(body).toEqual({ error: 'Missing or invalid exchange code' });
    });
  });

  describe('invalid or expired code (401)', () => {
    it('POST_withExpiredCode_returns401', async () => {
      // Arrange
      vi.mocked(consumeExchangeCode).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'expired-code' }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(401);
      expect(body).toEqual({ error: 'Invalid or expired exchange code' });
    });

    it('POST_withAlreadyUsedCode_returns401', async () => {
      // Arrange
      vi.mocked(consumeExchangeCode).mockResolvedValue(null);

      const request = new Request('http://localhost/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'already-used-code' }),
      });

      // Act
      const response = await POST(request);

      // Assert
      expect(response.status).toBe(401);
      expect(consumeExchangeCode).toHaveBeenCalledWith('already-used-code');
    });
  });

  describe('error handling (500)', () => {
    it('POST_whenConsumeExchangeCodeThrows_returns500', async () => {
      // Arrange
      vi.mocked(consumeExchangeCode).mockRejectedValueOnce(
        new Error('Redis connection failed')
      );

      const request = new Request('http://localhost/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'valid-code' }),
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(body).toEqual({ error: 'Exchange failed' });
    });

    it('POST_whenBodyParsingFails_returns500', async () => {
      // Arrange
      const request = new Request('http://localhost/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json{{{',
      });

      // Act
      const response = await POST(request);
      const body = await response.json();

      // Assert
      expect(response.status).toBe(500);
      expect(body).toEqual({ error: 'Exchange failed' });
    });

    it('POST_whenInternalErrorOccurs_logsError', async () => {
      // Arrange
      const error = new Error('Something went wrong');
      vi.mocked(consumeExchangeCode).mockRejectedValueOnce(error);

      const request = new Request('http://localhost/api/auth/desktop/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'valid-code' }),
      });

      // Act
      await POST(request);

      // Assert
      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Desktop exchange error',
        error
      );
    });
  });
});

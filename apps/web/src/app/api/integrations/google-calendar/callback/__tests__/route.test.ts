/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';

// ============================================================================
// Contract Tests for /api/integrations/google-calendar/callback
//
// Tests the Google Calendar OAuth callback handler including state validation,
// token exchange, and credential storage.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      })),
    })),
  },
  googleCalendarConnections: { userId: 'userId' },
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    auth: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib', () => ({
  encrypt: vi.fn().mockResolvedValue('encrypted-value'),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue({
      tokens: {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expiry_date: Date.now() + 3600000,
      },
    }),
    setCredentials: vi.fn(),
  })),
}));

vi.mock('@/lib/integrations/google-calendar/return-url', () => ({
  GOOGLE_CALENDAR_DEFAULT_RETURN_PATH: '/settings/integrations/google-calendar',
  normalizeGoogleCalendarReturnPath: vi.fn(
    (url: string) => url || '/settings/integrations/google-calendar'
  ),
}));

// Mock global fetch for user info
const mockFetchFn = vi.fn();
vi.stubGlobal('fetch', mockFetchFn);

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { encrypt } from '@pagespace/lib';
import { OAuth2Client } from 'google-auth-library';
import { GET } from '../route';

// Helper to create valid signed state
function createValidState(
  userId: string,
  returnUrl = '/settings/integrations/google-calendar',
  timestamp = Date.now()
) {
  const stateData = { userId, returnUrl, timestamp };
  const statePayload = JSON.stringify(stateData);
  const signature = crypto
    .createHmac('sha256', 'test-state-secret')
    .update(statePayload)
    .digest('hex');
  const stateWithSignature = JSON.stringify({ data: stateData, sig: signature });
  return Buffer.from(stateWithSignature).toString('base64');
}

describe('GET /api/integrations/google-calendar/callback', () => {
  const mockUserId = 'user_123';
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();

    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
    process.env.OAUTH_STATE_SECRET = 'test-state-secret';
    process.env.WEB_APP_URL = 'https://app.example.com';

    // Mock successful user info fetch
    mockFetchFn.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          email: 'user@gmail.com',
          id: 'google_123',
          verified_email: true,
        }),
    });

    vi.mocked(encrypt).mockResolvedValue('encrypted-value');
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    } as any);

    // Reset OAuth2Client mock
    vi.mocked(OAuth2Client).mockImplementation(
      () =>
        ({
          getToken: vi.fn().mockResolvedValue({
            tokens: {
              access_token: 'test-access-token',
              refresh_token: 'test-refresh-token',
              expiry_date: Date.now() + 3600000,
            },
          }),
          setCredentials: vi.fn(),
        }) as any
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('environment validation', () => {
    it('should redirect with error when OAuth env vars missing', async () => {
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;

      const state = createValidState(mockUserId);
      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?code=test-code&state=${state}`
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('error=oauth_config');
    });
  });

  describe('OAuth errors', () => {
    it('should redirect with access_denied for denied access', async () => {
      const request = new Request(
        'https://example.com/api/integrations/google-calendar/callback?error=access_denied'
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('error=access_denied');
    });

    it('should redirect with oauth_error for other errors', async () => {
      const request = new Request(
        'https://example.com/api/integrations/google-calendar/callback?error=server_error'
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('error=oauth_error');
    });
  });

  describe('parameter validation', () => {
    it('should redirect with error when code is missing', async () => {
      const state = createValidState(mockUserId);
      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?state=${state}`
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('error=invalid_request');
    });

    it('should redirect with error when state is missing', async () => {
      const request = new Request(
        'https://example.com/api/integrations/google-calendar/callback?code=test-code'
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('error=invalid_request');
    });
  });

  describe('state validation', () => {
    it('should redirect with error for invalid state structure', async () => {
      const invalidState = Buffer.from(JSON.stringify({ bad: 'structure' })).toString('base64');

      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?code=test-code&state=${invalidState}`
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('error=invalid_state');
    });

    it('should redirect with error for tampered signature', async () => {
      const stateData = { userId: mockUserId, returnUrl: '/settings', timestamp: Date.now() };
      const stateWithSignature = JSON.stringify({ data: stateData, sig: 'bad-signature' });
      const tamperedState = Buffer.from(stateWithSignature).toString('base64');

      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?code=test-code&state=${tamperedState}`
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('error=invalid_state');
    });

    it('should redirect with error for expired state', async () => {
      const expiredTimestamp = Date.now() - 11 * 60 * 1000; // 11 minutes ago
      const expiredState = createValidState(mockUserId, '/settings', expiredTimestamp);

      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?code=test-code&state=${expiredState}`
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('error=state_expired');
    });
  });

  describe('token exchange', () => {
    it('should redirect with error when tokens missing', async () => {
      vi.mocked(OAuth2Client).mockImplementation(
        () =>
          ({
            getToken: vi.fn().mockResolvedValue({
              tokens: { access_token: null, refresh_token: null },
            }),
            setCredentials: vi.fn(),
          }) as any
      );

      const state = createValidState(mockUserId);
      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?code=test-code&state=${state}`
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('error=missing_tokens');
    });
  });

  describe('user info validation', () => {
    it('should redirect with error when user info fetch fails', async () => {
      mockFetchFn.mockResolvedValue({ ok: false, status: 403 });

      const state = createValidState(mockUserId);
      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?code=test-code&state=${state}`
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('error=user_info_failed');
    });

    it('should redirect with error when email missing from user info', async () => {
      mockFetchFn.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'google_123', verified_email: true }),
      });

      const state = createValidState(mockUserId);
      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?code=test-code&state=${state}`
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('error=user_info_incomplete');
    });

    it('should redirect with error when email not verified', async () => {
      mockFetchFn.mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            email: 'user@gmail.com',
            id: 'google_123',
            verified_email: false,
          }),
      });

      const state = createValidState(mockUserId);
      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?code=test-code&state=${state}`
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('error=email_not_verified');
    });
  });

  describe('success path', () => {
    it('should encrypt tokens and store connection', async () => {
      const state = createValidState(mockUserId);
      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?code=test-code&state=${state}`
      );
      await GET(request);

      // Should encrypt both tokens
      expect(encrypt).toHaveBeenCalledWith('test-access-token');
      expect(encrypt).toHaveBeenCalledWith('test-refresh-token');

      // Should upsert connection
      expect(db.insert).toHaveBeenCalled();
    });

    it('should redirect with connected=true on success', async () => {
      const state = createValidState(mockUserId);
      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?code=test-code&state=${state}`
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toContain('connected=true');
    });

    it('should log successful connection', async () => {
      const state = createValidState(mockUserId);
      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?code=test-code&state=${state}`
      );
      await GET(request);

      expect(loggers.auth.info).toHaveBeenCalledWith(
        'Google Calendar connected successfully',
        expect.objectContaining({ userId: mockUserId })
      );
    });
  });

  describe('error handling', () => {
    it('should redirect with unexpected error on uncaught exception', async () => {
      vi.mocked(OAuth2Client).mockImplementation(() => {
        throw new Error('Unexpected crash');
      });

      const state = createValidState(mockUserId);
      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?code=test-code&state=${state}`
      );
      const response = await GET(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toContain('error=unexpected');
    });

    it('should log error on uncaught exception', async () => {
      const error = new Error('Unexpected crash');
      vi.mocked(OAuth2Client).mockImplementation(() => {
        throw error;
      });

      const state = createValidState(mockUserId);
      const request = new Request(
        `https://example.com/api/integrations/google-calendar/callback?code=test-code&state=${state}`
      );
      await GET(request);

      expect(loggers.auth.error).toHaveBeenCalledWith(
        'Google Calendar OAuth callback error',
        error
      );
    });
  });
});

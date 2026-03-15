/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { SessionAuthResult, AuthError } from '@/lib/auth';

// ============================================================================
// Contract Tests for /api/integrations/google-calendar/connect
//
// Tests the route handler's contract for initiating Google Calendar OAuth flow.
// ============================================================================

vi.mock('@pagespace/db', () => ({
  db: {
    query: {
      users: { findFirst: vi.fn() },
    },
  },
  users: { id: 'id', email: 'email' },
  eq: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(),
  getClientIP: vi.fn().mockReturnValue('127.0.0.1'),
}));

vi.mock('@pagespace/lib/server', () => ({
  loggers: {
    api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    auth: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  },
}));

vi.mock('@pagespace/lib/security', () => ({
  checkDistributedRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  DISTRIBUTED_RATE_LIMITS: { LOGIN: { maxAttempts: 5, windowMs: 900000 } },
}));

vi.mock('@/lib/integrations/google-calendar/return-url', () => ({
  normalizeGoogleCalendarReturnPath: vi.fn((url: string) => url || '/settings/integrations/google-calendar'),
}));

import { db } from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { checkDistributedRateLimit } from '@pagespace/lib/security';
import { POST } from '../route';

const mockWebAuth = (userId: string): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'test-session-id',
  adminRoleVersion: 0,
  role: 'user',
});

const mockAuthError = (status = 401): AuthError => ({
  error: NextResponse.json({ error: 'Unauthorized' }, { status }),
});

describe('POST /api/integrations/google-calendar/connect', () => {
  const mockUserId = 'user_123';
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockWebAuth(mockUserId));
    vi.mocked(isAuthError).mockReturnValue(false);
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: mockUserId,
      email: 'user@example.com',
    });
    vi.mocked(checkDistributedRateLimit).mockResolvedValue({ allowed: true, remaining: 4, retryAfter: 0 });

    // Set required env vars
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-client-secret';
    process.env.OAUTH_STATE_SECRET = 'test-state-secret-that-is-long-enough';
    process.env.WEB_APP_URL = 'https://app.example.com';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('authentication', () => {
    it('should return 401 when not authenticated', async () => {
      vi.mocked(isAuthError).mockReturnValue(true);
      vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuthError(401));

      const request = new Request('https://example.com/api/integrations/google-calendar/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(request);

      expect(response.status).toBe(401);
    });

    it('should call authenticateRequestWithOptions with CSRF required', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await POST(request);

      expect(authenticateRequestWithOptions).toHaveBeenCalledWith(
        request,
        { allow: ['session'], requireCSRF: true }
      );
    });
  });

  describe('environment validation', () => {
    it('should return 500 when GOOGLE_OAUTH_CLIENT_ID is missing', async () => {
      delete process.env.GOOGLE_OAUTH_CLIENT_ID;

      const request = new Request('https://example.com/api/integrations/google-calendar/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('OAuth not configured');
    });

    it('should return 500 when GOOGLE_OAUTH_CLIENT_SECRET is missing', async () => {
      delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;

      const request = new Request('https://example.com/api/integrations/google-calendar/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('OAuth not configured');
    });

    it('should return 500 when OAUTH_STATE_SECRET is missing', async () => {
      delete process.env.OAUTH_STATE_SECRET;

      const request = new Request('https://example.com/api/integrations/google-calendar/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('OAuth not configured');
    });
  });

  describe('user lookup', () => {
    it('should return 404 when user not found', async () => {
      vi.mocked(db.query.users.findFirst).mockResolvedValue(null as any);

      const request = new Request('https://example.com/api/integrations/google-calendar/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(404);
      expect(body.error).toBe('User not found');
    });
  });

  describe('rate limiting', () => {
    it('should return 429 when rate limited', async () => {
      vi.mocked(checkDistributedRateLimit).mockResolvedValue({
        allowed: false,
        remaining: 0,
        retryAfter: 300,
      });

      const request = new Request('https://example.com/api/integrations/google-calendar/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(429);
      expect(body.error).toContain('Too many connection attempts');
      expect(body.retryAfter).toBe(300);
    });
  });

  describe('success path', () => {
    it('should return OAuth URL', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(body.url).toContain('client_id=test-client-id');
      expect(body.url).toContain('response_type=code');
      expect(body.url).toContain('scope=');
    });

    it('should include login_hint when user has email', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(body.url).toContain('login_hint=user%40example.com');
    });

    it('should handle request body without JSON gracefully', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/connect', {
        method: 'POST',
      });
      const response = await POST(request);

      expect(response.status).toBe(200);
    });

    it('should log OAuth initiation', async () => {
      const request = new Request('https://example.com/api/integrations/google-calendar/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await POST(request);

      expect(loggers.auth.info).toHaveBeenCalledWith(
        'Google Calendar OAuth initiated',
        expect.objectContaining({ userId: mockUserId })
      );
    });
  });

  describe('error handling', () => {
    it('should return 500 when unexpected error occurs', async () => {
      vi.mocked(db.query.users.findFirst).mockRejectedValue(new Error('Unexpected'));

      const request = new Request('https://example.com/api/integrations/google-calendar/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const response = await POST(request);
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('An unexpected error occurred');
    });
  });
});

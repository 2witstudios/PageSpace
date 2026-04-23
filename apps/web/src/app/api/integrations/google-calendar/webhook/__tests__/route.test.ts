import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from '../route';
import { generateWebhookToken } from '@/lib/integrations/google-calendar/webhook-token';
import { _resetWarningFlag } from '@/lib/integrations/google-calendar/webhook-auth';

// Mock the sync service
vi.mock('@/lib/integrations/google-calendar/sync-service', () => ({
  syncGoogleCalendar: vi.fn().mockResolvedValue(undefined),
}));

// Mock loggers
vi.mock('@pagespace/lib/logging/logger-config', () => ({
    loggers: {
    api: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },

  logger: { child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
}));

// Mock next/server after() - it executes the callback synchronously in tests
vi.mock('next/server', async () => {
  const actual = await vi.importActual('next/server');
  return {
    ...actual,
    after: (fn: () => void) => fn(),
  };
});

describe('Google Calendar Webhook Route', () => {
  const originalEnv = process.env;
  const TEST_SECRET = 'test-oauth-state-secret';

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.OAUTH_STATE_SECRET = TEST_SECRET;
    _resetWarningFlag();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function createWebhookRequest(overrides: {
    channelId?: string | null;
    resourceId?: string | null;
    resourceState?: string;
    channelToken?: string | null;
  } = {}): Request {
    const headers: Record<string, string> = {};

    if (overrides.channelId !== null) {
      headers['X-Goog-Channel-ID'] = overrides.channelId ?? 'channel-123';
    }
    if (overrides.resourceId !== null) {
      headers['X-Goog-Resource-ID'] = overrides.resourceId ?? 'resource-456';
    }
    if (overrides.resourceState) {
      headers['X-Goog-Resource-State'] = overrides.resourceState;
    }
    if (overrides.channelToken !== null && overrides.channelToken !== undefined) {
      headers['X-Goog-Channel-Token'] = overrides.channelToken;
    }

    return new Request('http://localhost:3000/api/integrations/google-calendar/webhook', {
      method: 'POST',
      headers,
    });
  }

  describe('header validation', () => {
    it('given missing channel ID, should return 400', async () => {
      const request = createWebhookRequest({
        channelId: null,
        resourceId: 'resource-123',
        resourceState: 'exists',
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Missing headers');
    });

    it('given missing resource ID, should return 400', async () => {
      const request = createWebhookRequest({
        channelId: 'channel-123',
        resourceId: null,
        resourceState: 'exists',
      });

      const response = await POST(request);

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Missing headers');
    });
  });

  describe('sync confirmation (resourceState=sync)', () => {
    it('given sync state with valid token, should return 200', async () => {
      const userId = 'user-sync-123';
      const token = generateWebhookToken(userId);

      const request = createWebhookRequest({
        resourceState: 'sync',
        channelToken: token,
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
    });

    it('given sync state without token, should return 401', async () => {
      const request = createWebhookRequest({
        resourceState: 'sync',
        channelToken: null,
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Missing authentication token');
    });

    it('given sync state with invalid token, should return 401', async () => {
      const request = createWebhookRequest({
        resourceState: 'sync',
        channelToken: 'invalid.token',
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Invalid authentication token');
    });

    it('given sync state with valid token, should NOT trigger calendar sync', async () => {
      const { syncGoogleCalendar } = await import('@/lib/integrations/google-calendar/sync-service');
      const userId = 'user-sync-456';
      const token = generateWebhookToken(userId);

      const request = createWebhookRequest({
        resourceState: 'sync',
        channelToken: token,
      });

      await POST(request);

      expect(syncGoogleCalendar).not.toHaveBeenCalled();
    });
  });

  describe('zero-trust authentication', () => {
    it('given valid token, should return 200 and trigger sync', async () => {
      const { syncGoogleCalendar } = await import('@/lib/integrations/google-calendar/sync-service');
      const userId = 'user-123';
      const token = generateWebhookToken(userId);

      const request = createWebhookRequest({
        resourceState: 'exists',
        channelToken: token,
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.ok).toBe(true);
      expect(syncGoogleCalendar).toHaveBeenCalledWith(userId);
    });

    it('given missing token, should return 401 and NOT trigger sync', async () => {
      const { syncGoogleCalendar } = await import('@/lib/integrations/google-calendar/sync-service');

      const request = createWebhookRequest({
        resourceState: 'exists',
        channelToken: null,
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Missing authentication token');
      expect(syncGoogleCalendar).not.toHaveBeenCalled();
    });

    it('given invalid token, should return 401 and NOT trigger sync', async () => {
      const { syncGoogleCalendar } = await import('@/lib/integrations/google-calendar/sync-service');

      const request = createWebhookRequest({
        resourceState: 'exists',
        channelToken: 'invalid.token',
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Invalid authentication token');
      expect(syncGoogleCalendar).not.toHaveBeenCalled();
    });

    it('given tampered token, should return 401 and NOT trigger sync', async () => {
      const { syncGoogleCalendar } = await import('@/lib/integrations/google-calendar/sync-service');
      const validToken = generateWebhookToken('user-123');
      const tamperedToken = validToken.slice(0, -8) + 'deadbeef';

      const request = createWebhookRequest({
        resourceState: 'exists',
        channelToken: tamperedToken,
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Invalid authentication token');
      expect(syncGoogleCalendar).not.toHaveBeenCalled();
    });
  });

  describe('no fallback paths (critical security tests)', () => {
    it('given valid channel/resource IDs but no token, should NOT trigger sync', async () => {
      const { syncGoogleCalendar } = await import('@/lib/integrations/google-calendar/sync-service');

      const request = createWebhookRequest({
        channelId: 'valid-channel-id',
        resourceId: 'valid-resource-id',
        resourceState: 'exists',
        channelToken: null,
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      expect(syncGoogleCalendar).not.toHaveBeenCalled();
    });

    it('given valid channel/resource IDs with invalid token, should NOT trigger sync', async () => {
      const { syncGoogleCalendar } = await import('@/lib/integrations/google-calendar/sync-service');

      const request = createWebhookRequest({
        channelId: 'valid-channel-id',
        resourceId: 'valid-resource-id',
        resourceState: 'exists',
        channelToken: 'invalid.signature',
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      expect(syncGoogleCalendar).not.toHaveBeenCalled();
    });

    it('given matching channel/resource IDs with token for different user, should sync with token user only', async () => {
      const { syncGoogleCalendar } = await import('@/lib/integrations/google-calendar/sync-service');
      const tokenUserId = 'token-user-456';
      const token = generateWebhookToken(tokenUserId);

      const request = createWebhookRequest({
        channelId: 'channel-for-different-user',
        resourceId: 'resource-for-different-user',
        resourceState: 'exists',
        channelToken: token,
      });

      const response = await POST(request);

      expect(response.status).toBe(200);
      // Sync is triggered for the user encoded in the token, not based on channel lookup
      expect(syncGoogleCalendar).toHaveBeenCalledWith(tokenUserId);
    });
  });

  describe('fail-closed behavior', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
    });

    it('given production without OAUTH_STATE_SECRET, should return 500', async () => {
      const { syncGoogleCalendar } = await import('@/lib/integrations/google-calendar/sync-service');
      delete process.env.OAUTH_STATE_SECRET;
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

      const request = createWebhookRequest({
        resourceState: 'exists',
        channelToken: 'any-token',
      });

      const response = await POST(request);

      expect(response.status).toBe(500);
      expect(syncGoogleCalendar).not.toHaveBeenCalled();
    });

    it('given development without OAUTH_STATE_SECRET, should return 401', async () => {
      const { syncGoogleCalendar } = await import('@/lib/integrations/google-calendar/sync-service');
      delete process.env.OAUTH_STATE_SECRET;
      (process.env as Record<string, string | undefined>).NODE_ENV = 'development';

      const request = createWebhookRequest({
        resourceState: 'exists',
        channelToken: 'any-token',
      });

      const response = await POST(request);

      expect(response.status).toBe(401);
      expect(syncGoogleCalendar).not.toHaveBeenCalled();
    });
  });

  describe('logging', () => {
    it('given auth failure, should log with channel/resource IDs', async () => {
      const { loggers } = await import('@pagespace/lib/server');

      const request = createWebhookRequest({
        channelId: 'log-test-channel',
        resourceId: 'log-test-resource',
        resourceState: 'exists',
        channelToken: null,
      });

      await POST(request);

      expect(loggers.api.warn).toHaveBeenCalledWith(
        'Google Calendar webhook: auth failed',
        expect.objectContaining({
          channelId: 'log-test-channel',
          resourceId: 'log-test-resource',
          hasToken: false,
        })
      );
    });

    it('given successful auth, should log sync trigger with userId', async () => {
      const { loggers } = await import('@pagespace/lib/server');
      const userId = 'log-user-123';
      const token = generateWebhookToken(userId);

      const request = createWebhookRequest({
        channelId: 'log-channel',
        resourceState: 'exists',
        channelToken: token,
      });

      await POST(request);

      expect(loggers.api.info).toHaveBeenCalledWith(
        'Google Calendar webhook: triggering sync',
        expect.objectContaining({
          userId,
          channelId: 'log-channel',
          resourceState: 'exists',
        })
      );
    });
  });
});

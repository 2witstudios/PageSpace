/**
 * Tests for activity-tracker.ts
 *
 * Covers:
 *  - trackActivity (no user, with user, write error)
 *  - trackPageOperation, trackDriveOperation, trackFeature, trackAuthEvent, trackError
 *  - getUserIdFromRequest (valid cookie, no cookie, invalid token)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock variables ────────────────────────────────────────────────────
const mockWriteUserActivity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockApiDebug = vi.hoisted(() => vi.fn());
const mockValidateSession = vi.hoisted(() => vi.fn());

// ── Mock ../../logging/logger-database ────────────────────────────────────────
vi.mock('../../logging/logger-database', () => ({
  writeUserActivity: mockWriteUserActivity,
}));

// ── Mock ../../logging/logger-config ──────────────────────────────────────────
vi.mock('../../logging/logger-config', () => ({
  loggers: {
    api: {
      debug: mockApiDebug,
    },
  },
}));

// ── Mock ../../auth/session-service ───────────────────────────────────────────
vi.mock('../../auth/session-service', () => ({
  sessionService: {
    validateSession: mockValidateSession,
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import {
  trackActivity,
  trackPageOperation,
  trackDriveOperation,
  trackFeature,
  trackAuthEvent,
  trackError,
  getUserIdFromRequest,
} from '../activity-tracker';

// Helper: flush promise queue
const flush = () => new Promise(resolve => setTimeout(resolve, 10));

describe('activity-tracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteUserActivity.mockResolvedValue(undefined);
    mockValidateSession.mockResolvedValue(null);
  });

  // ── trackActivity ───────────────────────────────────────────────────────────
  describe('trackActivity', () => {
    it('should not write anything when userId is undefined', async () => {
      await trackActivity(undefined, 'page_create');
      await flush();
      expect(mockWriteUserActivity).not.toHaveBeenCalled();
    });

    it('should call writeUserActivity with the correct payload', async () => {
      await trackActivity('user-1', 'page_read', {
        resource: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
        pageId: 'page-1',
        sessionId: 'sess-1',
        ip: '127.0.0.1',
        userAgent: 'jest/test',
        metadata: { key: 'value' },
      });
      await flush();

      expect(mockWriteUserActivity).toHaveBeenCalledWith({
        userId: 'user-1',
        action: 'page_read',
        resource: 'page',
        resourceId: 'page-1',
        driveId: 'drive-1',
        pageId: 'page-1',
        sessionId: 'sess-1',
        ip: '127.0.0.1',
        userAgent: 'jest/test',
        metadata: { key: 'value' },
      });
    });

    it('should work with no data argument', async () => {
      await trackActivity('user-1', 'some_action');
      await flush();

      expect(mockWriteUserActivity).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'user-1', action: 'some_action' })
      );
    });

    it('should log a debug message and not throw on writeUserActivity error', async () => {
      mockWriteUserActivity.mockRejectedValueOnce(new Error('DB write failed'));

      await trackActivity('user-1', 'page_create');
      await flush();

      expect(mockApiDebug).toHaveBeenCalledWith(
        'Activity tracking failed',
        expect.objectContaining({ error: 'DB write failed', action: 'page_create' })
      );
    });
  });

  // ── trackPageOperation ──────────────────────────────────────────────────────
  describe('trackPageOperation', () => {
    it('should call trackActivity with page_<operation> action', async () => {
      trackPageOperation('user-1', 'create', 'page-1', { extra: true });
      await flush();

      expect(mockWriteUserActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          action: 'page_create',
          resource: 'page',
          resourceId: 'page-1',
          pageId: 'page-1',
          metadata: { extra: true },
        })
      );
    });

    it('should handle undefined userId', async () => {
      trackPageOperation(undefined, 'read', 'page-1');
      await flush();
      expect(mockWriteUserActivity).not.toHaveBeenCalled();
    });

    it('should work for all page operations', async () => {
      const operations = ['create', 'read', 'update', 'delete', 'share', 'restore', 'trash'] as const;
      for (const op of operations) {
        vi.clearAllMocks();
        trackPageOperation('user-1', op, 'page-1');
        await flush();
        expect(mockWriteUserActivity).toHaveBeenCalledWith(
          expect.objectContaining({ action: `page_${op}` })
        );
      }
    });
  });

  // ── trackDriveOperation ─────────────────────────────────────────────────────
  describe('trackDriveOperation', () => {
    it('should call trackActivity with drive_<operation> action', async () => {
      trackDriveOperation('user-1', 'access', 'drive-1');
      await flush();

      expect(mockWriteUserActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          action: 'drive_access',
          resource: 'drive',
          resourceId: 'drive-1',
          driveId: 'drive-1',
        })
      );
    });

    it('should handle undefined userId', async () => {
      trackDriveOperation(undefined, 'create', 'drive-1');
      await flush();
      expect(mockWriteUserActivity).not.toHaveBeenCalled();
    });

    it('should pass metadata', async () => {
      trackDriveOperation('user-1', 'invite_member', 'drive-1', { invitedUserId: 'u2' });
      await flush();
      expect(mockWriteUserActivity).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { invitedUserId: 'u2' } })
      );
    });
  });

  // ── trackFeature ────────────────────────────────────────────────────────────
  describe('trackFeature', () => {
    it('should call trackActivity with feature_<name> action', async () => {
      trackFeature('user-1', 'ai_chat');
      await flush();

      expect(mockWriteUserActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          action: 'feature_ai_chat',
          resource: 'feature',
          resourceId: 'ai_chat',
        })
      );
    });

    it('should handle undefined userId', async () => {
      trackFeature(undefined, 'ai_chat');
      await flush();
      expect(mockWriteUserActivity).not.toHaveBeenCalled();
    });

    it('should pass metadata', async () => {
      trackFeature('user-1', 'search', { query: 'hello' });
      await flush();
      expect(mockWriteUserActivity).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { query: 'hello' } })
      );
    });
  });

  // ── trackAuthEvent ──────────────────────────────────────────────────────────
  describe('trackAuthEvent', () => {
    it('should call trackActivity with auth_<event> action', async () => {
      trackAuthEvent('user-1', 'login');
      await flush();

      expect(mockWriteUserActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          action: 'auth_login',
          resource: 'auth',
        })
      );
    });

    it('should use "anonymous" when userId is undefined', async () => {
      trackAuthEvent(undefined, 'failed_login');
      await flush();

      expect(mockWriteUserActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'anonymous',
          action: 'auth_failed_login',
        })
      );
    });

    it('should work for all auth events', async () => {
      const events = ['login', 'logout', 'signup', 'refresh', 'failed_login', 'failed_oauth', 'email_verified', 'magic_link_login', 'passkey_login', 'passkey_registered', 'passkey_deleted'] as const;
      for (const event of events) {
        vi.clearAllMocks();
        trackAuthEvent('user-1', event);
        await flush();
        expect(mockWriteUserActivity).toHaveBeenCalledWith(
          expect.objectContaining({ action: `auth_${event}` })
        );
      }
    });
  });

  // ── trackError ──────────────────────────────────────────────────────────────
  describe('trackError', () => {
    it('should call trackActivity with error action', async () => {
      trackError('user-1', 'DB_ERROR', 'Connection refused');
      await flush();

      expect(mockWriteUserActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          action: 'error',
          resource: 'error',
          metadata: expect.objectContaining({
            type: 'DB_ERROR',
            message: 'Connection refused',
          }),
        })
      );
    });

    it('should truncate error message to 200 chars', async () => {
      const longMessage = 'E'.repeat(300);
      trackError('user-1', 'LONG_ERROR', longMessage);
      await flush();

      const call = mockWriteUserActivity.mock.calls[0][0];
      expect((call.metadata as Record<string, unknown>).message).toHaveLength(200);
    });

    it('should handle undefined userId', async () => {
      trackError(undefined, 'SOME_ERROR', 'An error occurred');
      await flush();
      expect(mockWriteUserActivity).not.toHaveBeenCalled();
    });

    it('should include optional context in metadata', async () => {
      const context = { route: '/api/pages', method: 'POST' };
      trackError('user-1', 'API_ERROR', 'Not found', context);
      await flush();

      const call = mockWriteUserActivity.mock.calls[0][0];
      expect((call.metadata as Record<string, unknown>).context).toEqual(context);
    });
  });

  // ── getUserIdFromRequest ────────────────────────────────────────────────────
  describe('getUserIdFromRequest', () => {
    it('should return undefined when there is no cookie header', async () => {
      const req = new Request('https://example.com', { headers: {} });
      const userId = await getUserIdFromRequest(req);
      expect(userId).toBeUndefined();
    });

    it('should return undefined when cookie header has no session cookie', async () => {
      const req = new Request('https://example.com', {
        headers: { cookie: 'other=value; another=thing' },
      });
      const userId = await getUserIdFromRequest(req);
      expect(userId).toBeUndefined();
    });

    it('should return userId from valid session cookie', async () => {
      mockValidateSession.mockResolvedValue({ userId: 'user-123' });
      const req = new Request('https://example.com', {
        headers: { cookie: 'session=valid-token-here' },
      });
      const userId = await getUserIdFromRequest(req);
      expect(userId).toBe('user-123');
      expect(mockValidateSession).toHaveBeenCalledWith('valid-token-here');
    });

    it('should return undefined when validateSession returns null', async () => {
      mockValidateSession.mockResolvedValue(null);
      const req = new Request('https://example.com', {
        headers: { cookie: 'session=invalid-token' },
      });
      const userId = await getUserIdFromRequest(req);
      expect(userId).toBeUndefined();
    });

    it('should return undefined when validateSession throws', async () => {
      mockValidateSession.mockRejectedValue(new Error('invalid token format'));
      const req = new Request('https://example.com', {
        headers: { cookie: 'session=bad-token' },
      });
      const userId = await getUserIdFromRequest(req);
      expect(userId).toBeUndefined();
    });

    it('should parse session from multiple cookies', async () => {
      mockValidateSession.mockResolvedValue({ userId: 'user-456' });
      const req = new Request('https://example.com', {
        headers: { cookie: 'other=abc; session=my-session-token; third=xyz' },
      });
      const userId = await getUserIdFromRequest(req);
      expect(userId).toBe('user-456');
      expect(mockValidateSession).toHaveBeenCalledWith('my-session-token');
    });
  });
});

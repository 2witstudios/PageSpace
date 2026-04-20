/**
 * Per-Event Authorization Tests
 * Tests for re-checking permissions on sensitive real-time events
 *
 * Zero-trust principle: Don't trust room membership alone for writes.
 * Re-verify permission before allowing document updates, etc.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shouldReauthorize, isSensitiveEvent, reauthorizePageAccess, withPerEventAuth, type AuthSocket, SensitiveEventType } from '../per-event-auth';

vi.mock('@pagespace/lib/logger-config', () => {
  const noop = vi.fn();
  const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop };
  return { loggers: { realtime: logger, api: logger, security: logger } };
});

vi.mock('@pagespace/lib/permissions', () => ({
  getUserAccessLevel: vi.fn(),
}));

import { getUserAccessLevel } from '@pagespace/lib/permissions';

describe('Per-Event Authorization', () => {
  describe('isSensitiveEvent', () => {
    it('given document_update event, should be sensitive', () => {
      expect(isSensitiveEvent('document_update')).toBe(true);
    });

    it('given page_content_change event, should be sensitive', () => {
      expect(isSensitiveEvent('page_content_change')).toBe(true);
    });

    it('given cursor_move event, should NOT be sensitive (read-only)', () => {
      expect(isSensitiveEvent('cursor_move')).toBe(false);
    });

    it('given presence_update event, should NOT be sensitive (read-only)', () => {
      expect(isSensitiveEvent('presence_update')).toBe(false);
    });

    it('given typing_indicator event, should NOT be sensitive', () => {
      expect(isSensitiveEvent('typing_indicator')).toBe(false);
    });
  });

  describe('shouldReauthorize', () => {
    it('given sensitive event in page room, should require re-auth', () => {
      const result = shouldReauthorize({
        eventType: 'document_update',
        roomType: 'page',
        resourceId: 'page-123',
      });

      expect(result).toBe(true);
    });

    it('given non-sensitive event, should NOT require re-auth', () => {
      const result = shouldReauthorize({
        eventType: 'cursor_move',
        roomType: 'page',
        resourceId: 'page-123',
      });

      expect(result).toBe(false);
    });

    it('given activity room event, should NOT require re-auth (read-only room)', () => {
      const result = shouldReauthorize({
        eventType: 'activity_logged',
        roomType: 'activity',
        resourceId: 'drive-123',
      });

      expect(result).toBe(false);
    });

    it('given notification room event, should NOT require re-auth (user-specific room)', () => {
      const result = shouldReauthorize({
        eventType: 'document_update',
        roomType: 'notification',
        resourceId: 'user-123',
      });

      expect(result).toBe(false);
    });
  });
});

describe('SensitiveEventType', () => {
  it('should include all write operations', () => {
    const sensitiveEvents: SensitiveEventType[] = [
      'document_update',
      'page_content_change',
      'page_delete',
      'page_move',
      'file_upload',
      'comment_create',
      'comment_delete',
      'task_create',
      'task_update',
      'task_delete',
    ];

    sensitiveEvents.forEach(event => {
      expect(isSensitiveEvent(event)).toBe(true);
    });
  });
});

describe('reauthorizePageAccess', () => {
  const mockedGetUserAccessLevel = vi.mocked(getUserAccessLevel);

  beforeEach(() => {
    mockedGetUserAccessLevel.mockReset();
  });

  it('calls getUserAccessLevel with bypassCache: true', async () => {
    mockedGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: true,
      canShare: false,
      canDelete: false,
    });

    await reauthorizePageAccess('user-1', 'page-1', 'edit');

    expect(mockedGetUserAccessLevel).toHaveBeenCalledWith('user-1', 'page-1', { bypassCache: true });
  });

  it('given revoked user (null permissions), should return authorized: false', async () => {
    mockedGetUserAccessLevel.mockResolvedValue(null);

    const result = await reauthorizePageAccess('user-revoked', 'page-1', 'edit');

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('No access to this page');
  });

  it('given user with view-only access requesting edit, should return authorized: false', async () => {
    mockedGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
    });

    const result = await reauthorizePageAccess('user-viewer', 'page-1', 'edit');

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('Requires edit permission');
  });

  it('given user with edit access, should return authorized: true', async () => {
    mockedGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: true,
      canShare: false,
      canDelete: false,
    });

    const result = await reauthorizePageAccess('user-editor', 'page-1', 'edit');

    expect(result.authorized).toBe(true);
  });

  it('given requiredLevel=view and canView is true, should return authorized: true', async () => {
    mockedGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
    });

    const result = await reauthorizePageAccess('user-viewer', 'page-1', 'view');

    expect(result.authorized).toBe(true);
  });

  it('given requiredLevel=view and canView is false, should return authorized: false', async () => {
    mockedGetUserAccessLevel.mockResolvedValue({
      canView: false,
      canEdit: false,
      canShare: false,
      canDelete: false,
    });

    const result = await reauthorizePageAccess('user-no-access', 'page-1', 'view');

    expect(result.authorized).toBe(false);
    expect(result.reason).toBe('Requires view permission');
  });
});

describe('withPerEventAuth', () => {
  const mockedGetUserAccessLevel = vi.mocked(getUserAccessLevel);

  beforeEach(() => {
    mockedGetUserAccessLevel.mockReset();
  });

  function createMockSocket(userId?: string): { socket: AuthSocket; emitFn: ReturnType<typeof vi.fn> } {
    const emitFn = vi.fn();
    const toFn = vi.fn().mockReturnValue({ emit: vi.fn() });
    return {
      socket: {
        data: { user: userId ? { id: userId, name: 'Test', avatarUrl: null } : undefined },
        emit: emitFn,
        to: toFn,
      } as unknown as AuthSocket,
      emitFn,
    };
  }

  it('given a non-sensitive event, should call handler directly without reauth', async () => {
    const handler = vi.fn();
    const { socket } = createMockSocket('user-1');
    const wrapped = withPerEventAuth(socket, 'cursor_move', handler, {
      pageIdExtractor: (p: unknown) => (p as { pageId?: string })?.pageId,
    });

    const payload = { pageId: 'page-1' };

    await wrapped(payload);

    expect(handler).toHaveBeenCalledWith(socket, payload);
    expect(mockedGetUserAccessLevel).not.toHaveBeenCalled();
  });

  it('given a sensitive event + authorized user, should call handler', async () => {
    mockedGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: true,
      canShare: false,
      canDelete: false,
    });

    const handler = vi.fn();
    const { socket } = createMockSocket('user-1');
    const wrapped = withPerEventAuth(socket, 'document_update', handler, {
      pageIdExtractor: (p: unknown) => (p as { pageId?: string })?.pageId,
    });

    const payload = { pageId: 'page-1' };

    await wrapped(payload);

    expect(handler).toHaveBeenCalledWith(socket, payload);
  });

  it('given a sensitive event + revoked user, should NOT call handler and should emit error', async () => {
    mockedGetUserAccessLevel.mockResolvedValue(null);

    const handler = vi.fn();
    const { socket, emitFn } = createMockSocket('user-revoked');
    const wrapped = withPerEventAuth(socket, 'document_update', handler, {
      pageIdExtractor: (p: unknown) => (p as { pageId?: string })?.pageId,
    });

    const payload = { pageId: 'page-1' };

    await wrapped(payload);

    expect(handler).not.toHaveBeenCalled();
    expect(emitFn).toHaveBeenCalledWith('error', expect.objectContaining({
      event: 'document_update',
      message: expect.stringContaining('denied'),
    }));
  });

  it('given auth check error, should fail closed (deny)', async () => {
    mockedGetUserAccessLevel.mockRejectedValue(new Error('DB connection error'));

    const handler = vi.fn();
    const { socket, emitFn } = createMockSocket('user-1');
    const wrapped = withPerEventAuth(socket, 'document_update', handler, {
      pageIdExtractor: (p: unknown) => (p as { pageId?: string })?.pageId,
    });

    const payload = { pageId: 'page-1' };

    await wrapped(payload);

    expect(handler).not.toHaveBeenCalled();
    expect(emitFn).toHaveBeenCalledWith('error', expect.objectContaining({
      event: 'document_update',
      message: expect.stringContaining('denied'),
    }));
  });

  it('given no user on socket, should not call handler', async () => {
    const handler = vi.fn();
    const { socket } = createMockSocket(); // no user
    const wrapped = withPerEventAuth(socket, 'document_update', handler, {
      pageIdExtractor: (p: unknown) => (p as { pageId?: string })?.pageId,
    });

    const payload = { pageId: 'page-1' };

    await wrapped(payload);

    expect(handler).not.toHaveBeenCalled();
  });

  it('given missing pageId from extractor, should not call handler', async () => {
    const handler = vi.fn();
    const { socket, emitFn } = createMockSocket('user-1');
    const wrapped = withPerEventAuth(socket, 'document_update', handler, {
      pageIdExtractor: () => undefined,
    });

    const payload = {};

    await wrapped(payload);

    expect(handler).not.toHaveBeenCalled();
    expect(emitFn).toHaveBeenCalledWith('error', expect.objectContaining({
      event: 'document_update',
    }));
  });

  it('given Socket.IO-style invocation (single arg), should work correctly', async () => {
    mockedGetUserAccessLevel.mockResolvedValue({
      canView: true,
      canEdit: true,
      canShare: false,
      canDelete: false,
    });

    const handler = vi.fn();
    const { socket } = createMockSocket('user-1');
    const listener = withPerEventAuth(socket, 'document_update', handler, {
      pageIdExtractor: (p: unknown) => (p as { pageId?: string })?.pageId,
    });

    // Simulate exactly how Socket.IO calls the listener: single payload argument
    const payload = { pageId: 'page-1', content: { text: 'hello' } };
    await listener(payload);

    expect(handler).toHaveBeenCalledWith(socket, payload);
    expect(mockedGetUserAccessLevel).toHaveBeenCalledWith('user-1', 'page-1', { bypassCache: true });
  });
});

// =============================================================================
// ZERO-TRUST ABUSE VECTOR TESTS
// =============================================================================

describe('Zero-Trust: Revoked-But-Connected Attack', () => {
  const mockedGetUserAccessLevel = vi.mocked(getUserAccessLevel);

  beforeEach(() => {
    mockedGetUserAccessLevel.mockReset();
  });

  function createMockSocket(userId?: string): { socket: AuthSocket; emitFn: ReturnType<typeof vi.fn> } {
    const emitFn = vi.fn();
    const toFn = vi.fn().mockReturnValue({ emit: vi.fn() });
    return {
      socket: {
        data: { user: userId ? { id: userId, name: 'Test', avatarUrl: null } : undefined },
        emit: emitFn,
        to: toFn,
      } as unknown as AuthSocket,
      emitFn,
    };
  }

  it('given user had edit access when joining, then revoked between events, second write should be denied', async () => {
    const handler = vi.fn();
    const { socket, emitFn } = createMockSocket('user-1');

    const wrapped = withPerEventAuth(socket, 'document_update', handler, {
      pageIdExtractor: (p: unknown) => (p as { pageId?: string })?.pageId,
    });

    // First event: user still has access
    mockedGetUserAccessLevel.mockResolvedValueOnce({
      canView: true,
      canEdit: true,
      canShare: false,
      canDelete: false,
    });

    await wrapped({ pageId: 'page-1' });
    expect(handler).toHaveBeenCalledTimes(1);

    // Permission revoked between events
    mockedGetUserAccessLevel.mockResolvedValueOnce(null);

    await wrapped({ pageId: 'page-1' });
    expect(handler).toHaveBeenCalledTimes(1); // NOT called again
    expect(emitFn).toHaveBeenCalledWith('error', expect.objectContaining({
      event: 'document_update',
    }));
  });

  it('given user had edit access downgraded to view-only, edit events should be denied', async () => {
    const handler = vi.fn();
    const { socket, emitFn } = createMockSocket('user-1');

    const wrapped = withPerEventAuth(socket, 'document_update', handler, {
      pageIdExtractor: (p: unknown) => (p as { pageId?: string })?.pageId,
    });

    // First: full access
    mockedGetUserAccessLevel.mockResolvedValueOnce({
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: true,
    });

    await wrapped({ pageId: 'page-1' });
    expect(handler).toHaveBeenCalledTimes(1);

    // Downgraded to view-only
    mockedGetUserAccessLevel.mockResolvedValueOnce({
      canView: true,
      canEdit: false,
      canShare: false,
      canDelete: false,
    });

    await wrapped({ pageId: 'page-1' });
    expect(handler).toHaveBeenCalledTimes(1); // NOT called again
    expect(emitFn).toHaveBeenCalledWith('error', expect.objectContaining({
      event: 'document_update',
      message: expect.stringContaining('denied'),
    }));
  });

  it('given intermittent DB failure during re-auth, event should be denied (fail-closed)', async () => {
    const handler = vi.fn();
    const { socket, emitFn } = createMockSocket('user-1');

    const wrapped = withPerEventAuth(socket, 'page_delete', handler, {
      pageIdExtractor: (p: unknown) => (p as { pageId?: string })?.pageId,
    });

    // DB error on permission check
    mockedGetUserAccessLevel.mockRejectedValueOnce(new Error('Connection reset'));

    await wrapped({ pageId: 'page-1' });

    expect(handler).not.toHaveBeenCalled();
    expect(emitFn).toHaveBeenCalledWith('error', expect.objectContaining({
      event: 'page_delete',
      message: expect.stringContaining('denied'),
    }));
  });
});

describe('Zero-Trust: All Sensitive Events Require Re-Auth', () => {
  const mockedGetUserAccessLevel = vi.mocked(getUserAccessLevel);

  beforeEach(() => {
    mockedGetUserAccessLevel.mockReset();
  });

  function createMockSocket(userId: string): { socket: AuthSocket; emitFn: ReturnType<typeof vi.fn> } {
    const emitFn = vi.fn();
    return {
      socket: {
        data: { user: { id: userId, name: 'Test', avatarUrl: null } },
        emit: emitFn,
        to: vi.fn().mockReturnValue({ emit: vi.fn() }),
      } as unknown as AuthSocket,
      emitFn,
    };
  }

  const allSensitiveEvents: SensitiveEventType[] = [
    'document_update',
    'page_content_change',
    'page_delete',
    'page_move',
    'file_upload',
    'comment_create',
    'comment_delete',
    'task_create',
    'task_update',
    'task_delete',
  ];

  for (const eventType of allSensitiveEvents) {
    it(`given '${eventType}' with revoked access, handler should NOT execute`, async () => {
      mockedGetUserAccessLevel.mockResolvedValue(null); // Access revoked

      const handler = vi.fn();
      const { socket, emitFn } = createMockSocket('user-revoked');

      const wrapped = withPerEventAuth(socket, eventType, handler, {
        pageIdExtractor: (p: unknown) => (p as { pageId?: string })?.pageId,
      });

      await wrapped({ pageId: 'page-1' });

      expect(handler).not.toHaveBeenCalled();
      expect(emitFn).toHaveBeenCalledWith('error', expect.objectContaining({
        event: eventType,
      }));
    });
  }
});

describe('Zero-Trust: Event Type Case Sensitivity', () => {
  it('given case-varied sensitive event name, should NOT trigger re-auth (treated as unknown)', () => {
    // Attackers cannot bypass by sending 'Document_Update' instead of 'document_update'
    expect(isSensitiveEvent('Document_Update')).toBe(false);
    expect(isSensitiveEvent('DOCUMENT_UPDATE')).toBe(false);
    expect(isSensitiveEvent('Page_Delete')).toBe(false);
  });

  it('given empty or whitespace event name, should NOT be sensitive', () => {
    expect(isSensitiveEvent('')).toBe(false);
    expect(isSensitiveEvent(' ')).toBe(false);
    expect(isSensitiveEvent('\n')).toBe(false);
  });
});

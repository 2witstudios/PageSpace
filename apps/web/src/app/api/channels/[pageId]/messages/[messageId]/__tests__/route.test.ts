/**
 * Contract tests for /api/channels/[pageId]/messages/[messageId]
 *
 * Focused on the new soft-delete idempotency contract introduced in PR 3:
 *   - DELETE returns 404 when softDeleteChannelMessage reports 0 rows affected
 *     (a double-DELETE or concurrent delete must NOT re-broadcast
 *     message_deleted or re-audit data.delete).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(
    (r: unknown) => typeof r === 'object' && r !== null && 'error' in r
  ),
}));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserEditPage: vi.fn().mockResolvedValue(true),
}));

const mockFindChannelMessageInPage = vi.fn();
const mockSoftDeleteChannelMessage = vi.fn();
const mockUpdateChannelMessageContent = vi.fn();
vi.mock('@pagespace/lib/services/channel-message-repository', () => ({
  channelMessageRepository: {
    findChannelMessageInPage: (...args: unknown[]) => mockFindChannelMessageInPage(...args),
    softDeleteChannelMessage: (...args: unknown[]) => mockSoftDeleteChannelMessage(...args),
    updateChannelMessageContent: (...args: unknown[]) => mockUpdateChannelMessageContent(...args),
  },
}));

const mockAuditRequest = vi.fn();
vi.mock('@pagespace/lib/audit/audit-log', () => ({
  auditRequest: (...args: unknown[]) => mockAuditRequest(...args),
}));
vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    realtime: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  },
}));
vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({ 'x-signed': 'yes' })),
}));

import { DELETE } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import type { SessionAuthResult } from '@/lib/auth';

const PAGE_ID = 'page_chan';
const MESSAGE_ID = 'msg_1';
const USER_ID = 'user_sender';

const sessionAuth = (userId = USER_ID): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess_test',
  role: 'user',
  adminRoleVersion: 0,
});

const callDelete = () =>
  DELETE(
    new Request(`http://localhost/api/channels/${PAGE_ID}/messages/${MESSAGE_ID}`, {
      method: 'DELETE',
    }),
    { params: Promise.resolve({ pageId: PAGE_ID, messageId: MESSAGE_ID }) }
  );

describe('DELETE /api/channels/[pageId]/messages/[messageId]', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalRealtimeUrl = process.env.INTERNAL_REALTIME_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_REALTIME_URL = 'http://realtime.test';
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
    mockFindChannelMessageInPage.mockResolvedValue({ id: MESSAGE_ID, pageId: PAGE_ID, userId: USER_ID, isActive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalRealtimeUrl === undefined) {
      delete process.env.INTERNAL_REALTIME_URL;
    } else {
      process.env.INTERNAL_REALTIME_URL = originalRealtimeUrl;
    }
  });

  it('soft-deletes, audits data.delete, and broadcasts message_deleted on a fresh delete', async () => {
    mockSoftDeleteChannelMessage.mockResolvedValueOnce(1);

    const res = await callDelete();

    expect(res.status).toBe(200);
    expect(mockAuditRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventType: 'data.delete', resourceId: MESSAGE_ID })
    );
    const broadcasts = fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('/api/broadcast'));
    expect(broadcasts).toHaveLength(1);
    expect(JSON.parse((broadcasts[0][1] as RequestInit).body as string).event).toBe('message_deleted');
  });

  it('returns 404 with NO duplicate audit and NO duplicate broadcast when softDelete reports 0 affected (double-DELETE / already-deleted)', async () => {
    // Concurrency: another DELETE landed between findChannelMessageInPage and
    // softDeleteChannelMessage. The function returned 0 because the row is
    // already inactive; the route must skip both audit and broadcast.
    mockSoftDeleteChannelMessage.mockResolvedValueOnce(0);

    const res = await callDelete();

    expect(res.status).toBe(404);
    expect(mockAuditRequest).not.toHaveBeenCalled();
    const broadcasts = fetchMock.mock.calls.filter(([url]) => typeof url === 'string' && url.includes('/api/broadcast'));
    expect(broadcasts).toHaveLength(0);
  });
});

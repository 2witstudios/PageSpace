/**
 * Contract tests for POST /api/channels/[pageId]/read
 *
 * This is the reference read-status implementation (upsert channel_read_status
 * + broadcast inbox:read_status_changed). Stage 2 of the unread redesign adds
 * a second responsibility: clearing the unread MENTION notifications left
 * behind for this page (Hole C) so the nav Channels badge and bell agree with
 * the channel's own read state.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Auth boundary --------------------------------------------------------------
vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn(
    (r: unknown) => typeof r === 'object' && r !== null && 'error' in r
  ),
}));

// --- Permissions -----------------------------------------------------------------
vi.mock('@pagespace/lib/permissions/permissions', () => ({
  canUserViewPage: vi.fn(),
}));

// --- DB seam -----------------------------------------------------------------------
const mockFindFirst = vi.fn();
const mockDbExecute = vi.fn();
vi.mock('@pagespace/db/db', () => ({
  db: {
    query: { pages: { findFirst: (...args: unknown[]) => mockFindFirst(...args) } },
    execute: (...args: unknown[]) => mockDbExecute(...args),
  },
}));

vi.mock('@pagespace/db/operators', () => ({
  sql: Object.assign(
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings.join('?'), values })),
    { placeholder: vi.fn() }
  ),
  eq: vi.fn((a, b) => ({ eq: [a, b] })),
}));

vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', type: 'type', driveId: 'driveId' },
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: {
    api: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  },
}));

// --- Realtime broadcast ------------------------------------------------------------
const mockBroadcastInboxEvent = vi.fn();
vi.mock('@/lib/websocket/socket-utils', () => ({
  broadcastInboxEvent: (...args: unknown[]) => mockBroadcastInboxEvent(...args),
}));

// --- Notifications -------------------------------------------------------------------
const mockMarkPageNotificationsRead = vi.fn();
vi.mock('@pagespace/lib/notifications/notifications', () => ({
  markPageNotificationsRead: (...args: unknown[]) => mockMarkPageNotificationsRead(...args),
}));

// --- Imports under test (must come after vi.mock blocks) ---------------------------
import { POST } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import type { SessionAuthResult } from '@/lib/auth';

const USER_ID = 'user_1';
const PAGE_ID = 'page_1';
const DRIVE_ID = 'drive_1';

const sessionAuth = (userId = USER_ID): SessionAuthResult => ({
  userId,
  tokenVersion: 0,
  tokenType: 'session',
  sessionId: 'sess_test',
  role: 'user',
  adminRoleVersion: 0,
});

function makeRequest(): Request {
  return new Request(`http://localhost/api/channels/${PAGE_ID}/read`, { method: 'POST' });
}

const callRoute = () =>
  POST(makeRequest(), { params: Promise.resolve({ pageId: PAGE_ID }) });

describe('POST /api/channels/[pageId]/read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(sessionAuth());
    mockFindFirst.mockResolvedValue({ id: PAGE_ID, type: 'CHANNEL', driveId: DRIVE_ID });
    vi.mocked(canUserViewPage).mockResolvedValue(true);
    mockDbExecute.mockResolvedValue(undefined);
    mockBroadcastInboxEvent.mockResolvedValue(undefined);
    mockMarkPageNotificationsRead.mockResolvedValue(0);
  });

  it('AC4: clears unread MENTION notifications for the page and reports the count in the response', async () => {
    mockMarkPageNotificationsRead.mockResolvedValue(3);

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mockMarkPageNotificationsRead).toHaveBeenCalledWith(USER_ID, PAGE_ID);
    const body = await res.json();
    expect(body).toEqual({ success: true, notificationsMarkedRead: 3 });
  });

  it('broadcasts inbox:read_status_changed with unreadCount 0', async () => {
    await callRoute();

    expect(mockBroadcastInboxEvent).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        operation: 'read_status_changed',
        type: 'channel',
        id: PAGE_ID,
        driveId: DRIVE_ID,
        unreadCount: 0,
      })
    );
  });

  it('returns 404 and never touches notifications when the page is not a channel', async () => {
    mockFindFirst.mockResolvedValue({ id: PAGE_ID, type: 'DOCUMENT', driveId: DRIVE_ID });

    const res = await callRoute();

    expect(res.status).toBe(404);
    expect(mockMarkPageNotificationsRead).not.toHaveBeenCalled();
    expect(mockBroadcastInboxEvent).not.toHaveBeenCalled();
  });

  it('returns 403 and never touches notifications when the caller cannot view the channel', async () => {
    vi.mocked(canUserViewPage).mockResolvedValue(false);

    const res = await callRoute();

    expect(res.status).toBe(403);
    expect(mockMarkPageNotificationsRead).not.toHaveBeenCalled();
    expect(mockBroadcastInboxEvent).not.toHaveBeenCalled();
  });
});

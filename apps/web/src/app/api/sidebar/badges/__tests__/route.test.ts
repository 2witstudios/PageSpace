/**
 * Tests for the `channels` figure of /api/sidebar/badges.
 *
 * The badge used to count unread MENTION notifications only, so an ordinary
 * message in a channel you belong to left it at zero. It now sums unread
 * messages past each channel's `channel_read_status` watermark — and, because
 * drive membership is not page access, only for channels the centralized
 * permission helper says the user can view.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((result: unknown) => result && typeof result === 'object' && 'error' in result),
}));

vi.mock('@pagespace/db/db', () => ({
  db: { execute: vi.fn(), select: vi.fn() },
}));

vi.mock('@pagespace/db/operators', () => {
  // Capture the literal text chunks so tests can identify which query ran.
  const sql = (strings: TemplateStringsArray, ..._values: unknown[]) => ({
    __sqlText: strings.join('?'),
  });
  const noop = (...args: unknown[]) => ({ __op: args });
  return {
    sql,
    eq: noop,
    ne: noop,
    and: noop,
    or: noop,
    isNull: noop,
    gte: noop,
    count: () => ({ __op: 'count' }),
  };
});

vi.mock('@pagespace/db/schema/social', () => ({ directMessages: {}, dmConversations: {} }));
vi.mock('@pagespace/db/schema/notifications', () => ({ notifications: {} }));
vi.mock('@pagespace/db/schema/core', () => ({ pages: {} }));
vi.mock('@pagespace/db/schema/calendar', () => ({ calendarEvents: {}, eventAttendees: {} }));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } },
}));

vi.mock('@pagespace/lib/audit/audit-log', () => ({ auditRequest: vi.fn() }));

vi.mock('@pagespace/lib/permissions/permissions', () => ({
  getBatchPagePermissions: vi.fn(),
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { db } from '@pagespace/db/db';
import { getBatchPagePermissions } from '@pagespace/lib/permissions/permissions';

const mockUserId = 'user_123';

const mockAuth = () => {
  vi.mocked(authenticateRequestWithOptions).mockResolvedValue({
    userId: mockUserId,
    tokenVersion: 0,
    tokenType: 'session' as const,
    sessionId: 'test-session',
    role: 'user' as const,
    adminRoleVersion: 0,
  });
};

/**
 * The other four badges use the Drizzle query builder, which is a thenable
 * chain. One self-returning thenable stands in for all of them and always
 * resolves to a zero count, so `channels` is the only figure under test.
 */
const stubQueryBuilder = () => {
  const chain: Record<string, unknown> = {
    then: (resolve: (value: unknown) => unknown) => resolve([{ count: 0 }]),
  };
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where']) {
    chain[method] = () => chain;
  }
  (db.select as unknown as ReturnType<typeof vi.fn>).mockReturnValue(chain);
};

const grantView = (...pageIds: string[]) => {
  vi.mocked(getBatchPagePermissions as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Map(
      pageIds.map((id) => [id, { canView: true, canEdit: false, canShare: false, canDelete: false }])
    )
  );
};

const withUnreadRows = (rows: Array<{ id: string; unread_count: string }>) => {
  (db.execute as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ rows });
};

const getChannels = async () => {
  const res = await GET(new Request('http://localhost/api/sidebar/badges'));
  expect(res.status).toBe(200);
  return (await res.json()).channels as number;
};

describe('GET /api/sidebar/badges — channels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth();
    stubQueryBuilder();
  });

  it('sums unread message counts across viewable channels', async () => {
    withUnreadRows([
      { id: 'ch_1', unread_count: '3' },
      { id: 'ch_2', unread_count: '4' },
    ]);
    grantView('ch_1', 'ch_2');

    expect(await getChannels()).toBe(7);
  });

  it('excludes channels the user cannot view', async () => {
    withUnreadRows([
      { id: 'ch_visible', unread_count: '2' },
      { id: 'ch_hidden', unread_count: '99' },
    ]);
    // ch_hidden is in one of the user's drives but permissioned away from them.
    grantView('ch_visible');

    expect(await getChannels()).toBe(2);
  });

  it('counts unread messages from the watermark query, not MENTION notifications', async () => {
    withUnreadRows([{ id: 'ch_1', unread_count: '5' }]);
    grantView('ch_1');

    await getChannels();

    const sqlText = String(
      (vi.mocked(db.execute).mock.calls[0][0] as unknown as { __sqlText: string }).__sqlText
    );
    expect(sqlText).toContain('channel_read_status');
    expect(sqlText).not.toContain('MENTION');
  });

  it('returns 0 and skips the permission batch when nothing is unread', async () => {
    withUnreadRows([]);

    expect(await getChannels()).toBe(0);
    expect(getBatchPagePermissions).not.toHaveBeenCalled();
  });
});

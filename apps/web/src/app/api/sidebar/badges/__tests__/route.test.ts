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
 * chain. Each `db.select()` gets its own self-returning thenable resolving to a
 * DISTINCT count, handed out in the order the route builds its Promise.all:
 * dms, files, tasks, calendar (channels is raw SQL and takes no slot).
 *
 * Distinct values are the point. With every chain resolving to 0, transposing
 * two names in the positional destructuring — which this route's change had to
 * touch — is invisible. See the response-contract test below.
 */
const SELECT_COUNTS = [11, 22, 33, 44];

const stubQueryBuilder = () => {
  let nth = 0;
  (db.select as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
    const value = SELECT_COUNTS[nth++] ?? 0;
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => resolve([{ count: value }]),
    };
    for (const method of ['from', 'innerJoin', 'leftJoin', 'where']) {
      chain[method] = () => chain;
    }
    return chain;
  });
};

const perm = (canView: boolean) => ({ canView, canEdit: false, canShare: false, canDelete: false });

/**
 * getBatchPagePermissions pre-seeds every id it was asked about with an explicit
 * deny, so "denied" arrives as a present entry with canView:false, not as an
 * absent key. Tests must be able to express both — a filter written as
 * `permissions.has(id)` passes the absent case while leaking the denied one.
 */
const setPermissions = (entries: Record<string, boolean>) => {
  vi.mocked(getBatchPagePermissions as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Map(Object.entries(entries).map(([id, canView]) => [id, perm(canView)]))
  );
};

const grantView = (...pageIds: string[]) =>
  setPermissions(Object.fromEntries(pageIds.map((id) => [id, true])));

const withUnreadRows = (rows: Array<{ id: string; unread_count: string }>) => {
  (db.execute as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ rows });
};

const getBadges = async () => {
  const res = await GET(new Request('http://localhost/api/sidebar/badges'));
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, number>;
};

const getChannels = async () => (await getBadges()).channels;

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

  it('excludes a channel present in the permission map but denied', async () => {
    withUnreadRows([
      { id: 'ch_visible', unread_count: '2' },
      { id: 'ch_denied', unread_count: '99' },
    ]);
    // ch_denied is in one of the user's drives but permissioned away from them.
    // It is PRESENT with canView:false — the shape getBatchPagePermissions
    // actually returns — so a `permissions.has(id)` filter would leak it.
    setPermissions({ ch_visible: true, ch_denied: false });

    expect(await getChannels()).toBe(2);
  });

  it('excludes a channel absent from the permission map', async () => {
    withUnreadRows([
      { id: 'ch_visible', unread_count: '2' },
      { id: 'ch_missing', unread_count: '99' },
    ]);
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

  it('reports 0 unread channels rather than blanking every badge when the query fails', async () => {
    // The channel slot sits in a Promise.all: an unhandled rejection 500s the
    // route, and the client renders that as all five badges empty. Only the
    // channel figure should degrade.
    (db.execute as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    const badges = await getBadges();
    expect(badges.channels).toBe(0);
    expect(badges.dms).toBe(SELECT_COUNTS[0]);
    expect(badges.calendar).toBe(SELECT_COUNTS[3]);
  });

  it('keeps each badge wired to its own query', async () => {
    // Guards the positional destructuring of the Promise.all, which this
    // route's change had to renumber. Each db.select() resolves to a distinct
    // count in build order, so a transposition shows up as swapped values.
    withUnreadRows([{ id: 'ch_1', unread_count: '5' }]);
    grantView('ch_1');

    expect(await getBadges()).toEqual({
      dms: SELECT_COUNTS[0],
      channels: 5,
      files: SELECT_COUNTS[1],
      tasks: SELECT_COUNTS[2],
      calendar: SELECT_COUNTS[3],
    });
  });
});

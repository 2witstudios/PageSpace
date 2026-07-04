/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// GET /api/pulse — task stats must exclude trashed pages and pages outside the
// user's current drive membership.
//
// Bug: the four task-count queries (overdue/dueToday/dueThisWeek/completedThisWeek)
// used to query `taskItems` directly with no join to `pages` at all, so a task
// whose page had been trashed (or whose drive the user no longer belonged to)
// was still counted as overdue forever, even though it's unreachable in the UI.
//
// These tests build a tiny fixture-based fake DB (see task-fixture-db.ts) that
// genuinely evaluates the query's where-condition against fixture rows, so they
// actually catch a regression that drops the trash/drive-membership filter —
// not just that a filter argument was present somewhere.
// ============================================================================

const h = vi.hoisted(() => ({
  tableRows: new Map<unknown, Record<string, unknown>[]>(),
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: any) => r != null && typeof r === 'object' && 'error' in r),
}));

vi.mock('@pagespace/lib/logging/logger-config', () => ({
  loggers: { api: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), trace: vi.fn() } },
}));

vi.mock('@pagespace/lib/billing/automation-preferences', () => ({
  resolvePulseEnabled: vi.fn(() => true),
}));

vi.mock('@/lib/ai/core/timestamp-utils', () => ({
  getStartOfTodayInTimezone: vi.fn(() => new Date('2024-01-10T00:00:00.000Z')),
  normalizeTimezone: vi.fn(() => 'UTC'),
}));

vi.mock('@pagespace/db/db', async () => {
  const { createFixtureSelect: create } = await import('./task-fixture-db');
  return { db: { select: create(h.tableRows) } };
});

vi.mock('@pagespace/db/operators', async () => {
  const { fixtureOperators } = await import('./task-fixture-db');
  return fixtureOperators;
});

vi.mock('@pagespace/db/schema/auth', () => ({
  users: { id: 'id', timezone: 'timezone' },
}));
vi.mock('@pagespace/db/schema/core', () => ({
  pages: { id: 'id', driveId: 'driveId', isTrashed: 'isTrashed', updatedAt: 'updatedAt', title: 'title' },
}));
vi.mock('@pagespace/db/schema/members', () => ({
  driveMembers: { driveId: 'driveId', userId: 'userId', acceptedAt: 'acceptedAt' },
}));
vi.mock('@pagespace/db/schema/tasks', () => ({
  taskItems: {
    pageId: 'pageId', assigneeId: 'assigneeId', userId: 'userId', status: 'status',
    dueDate: 'dueDate', completedAt: 'completedAt', priority: 'priority',
  },
}));
vi.mock('@pagespace/db/schema/calendar', () => ({
  calendarEvents: {
    id: 'id', driveId: 'driveId', createdById: 'createdById', visibility: 'visibility',
    isTrashed: 'isTrashed', startAt: 'startAt',
  },
  eventAttendees: { userId: 'userId', status: 'status', eventId: 'eventId' },
}));
vi.mock('@pagespace/db/schema/social', () => ({
  directMessages: { conversationId: 'conversationId', senderId: 'senderId', isRead: 'isRead', isActive: 'isActive', parentId: 'parentId' },
  dmConversations: { id: 'id', participant1Id: 'participant1Id', participant2Id: 'participant2Id' },
}));
vi.mock('@pagespace/db/schema/dashboard', () => ({
  pulseSummaries: { userId: 'userId', generatedAt: 'generatedAt', id: 'id', summary: 'summary', greeting: 'greeting', expiresAt: 'expiresAt' },
}));
vi.mock('@pagespace/db/schema/automation-preferences', () => ({
  userAutomationPreferences: { userId: 'userId', pulseEnabled: 'pulseEnabled' },
}));

import { GET } from '../route';
import { authenticateRequestWithOptions } from '@/lib/auth';
import { users } from '@pagespace/db/schema/auth';
import { driveMembers } from '@pagespace/db/schema/members';
import { taskItems } from '@pagespace/db/schema/tasks';
import { pulseSummaries } from '@pagespace/db/schema/dashboard';
import { dmConversations } from '@pagespace/db/schema/social';

const USER_ID = 'user-1';
const IN_DRIVE = 'drive-in';
const OUT_DRIVE = 'drive-out';

const mockAuth = () => ({
  userId: USER_ID,
  tokenVersion: 0,
  tokenType: 'session' as const,
  sessionId: 'sess-1',
  role: 'user' as const,
  adminRoleVersion: 0,
});

// An overdue task row (due before "today" = 2024-01-10) as it would be flattened
// from `taskItems` innerJoin `pages`.
const overdueTaskRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  assigneeId: USER_ID,
  userId: USER_ID,
  status: 'pending',
  dueDate: new Date('2024-01-05T00:00:00.000Z'),
  completedAt: null,
  priority: 'medium',
  driveId: IN_DRIVE,
  isTrashed: false,
  ...overrides,
});

function setupTables(taskRows: Record<string, unknown>[], driveMemberRows: Record<string, unknown>[]) {
  h.tableRows.clear();
  h.tableRows.set(users, [{ id: USER_ID, timezone: 'UTC' }]);
  h.tableRows.set(driveMembers, driveMemberRows);
  h.tableRows.set(taskItems, taskRows);
  h.tableRows.set(pulseSummaries, []);
  h.tableRows.set(dmConversations, []);
  // Every other table (calendarEvents, eventAttendees, pages) defaults to [] via
  // `tableRows.get(table) ?? []` in the fixture builder — no entry needed.
}

describe('GET /api/pulse — task counts scoped to trash + drive membership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
  });

  it('excludes an overdue task whose page has been trashed', async () => {
    setupTables(
      [overdueTaskRow({ isTrashed: true })],
      [{ userId: USER_ID, acceptedAt: new Date(), driveId: IN_DRIVE }]
    );

    const response = await GET(new Request('https://example.com/api/pulse'));
    const body = await response.json();

    expect(body.stats.tasks.overdue).toBe(0);
  });

  it("excludes an overdue task whose page's drive is outside the user's current membership", async () => {
    setupTables(
      [overdueTaskRow({ driveId: OUT_DRIVE })],
      [{ userId: USER_ID, acceptedAt: new Date(), driveId: IN_DRIVE }] // user only belongs to IN_DRIVE
    );

    const response = await GET(new Request('https://example.com/api/pulse'));
    const body = await response.json();

    expect(body.stats.tasks.overdue).toBe(0);
  });

  it('counts a normal overdue task (not trashed, drive accessible) same as before', async () => {
    setupTables(
      [overdueTaskRow()],
      [{ userId: USER_ID, acceptedAt: new Date(), driveId: IN_DRIVE }]
    );

    const response = await GET(new Request('https://example.com/api/pulse'));
    const body = await response.json();

    expect(body.stats.tasks.overdue).toBe(1);
  });

  it('resolves task counts to 0 when the user has no accepted drive memberships', async () => {
    setupTables(
      [overdueTaskRow()], // would count if driveIds guard were missing
      [] // no drive memberships at all
    );

    const response = await GET(new Request('https://example.com/api/pulse'));
    const body = await response.json();

    expect(body.stats.tasks).toEqual({
      overdue: 0,
      dueToday: 0,
      dueThisWeek: 0,
      completedThisWeek: 0,
    });
  });
});

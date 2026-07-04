import { describe, it, expect, beforeEach, vi } from 'vitest';

// ============================================================================
// GET /api/pulse — task stats must exclude tasks whose page isn't in the
// user's accessible-pages set (trashed page, page in a trashed drive, drive
// membership revoked), while still including tasks on pages the user can
// reach via owner access (even with no accepted drive_members row yet — that
// row is only lazily backfilled on first drive access) or an explicit
// page-level permission grant with no drive membership at all.
//
// Bug: the four task-count queries (overdue/dueToday/dueThisWeek/completedThisWeek)
// used to query `taskItems` directly with no join to `pages` at all, so a task
// whose page had been trashed (or whose drive the user no longer belonged to)
// was still counted as overdue forever, even though it's unreachable in the UI.
//
// The fix scopes tasks via `taskItems.pageId IN (SELECT page_id FROM
// accessible_page_ids_for_user(userId))` — the same canonical, already-tested
// DB function used elsewhere in Pulse for page/content access — rather than a
// hand-rolled driveId filter, so these tests model "is this page accessible"
// directly via a fixture set instead of re-deriving trash/membership/ownership
// logic that's that function's own responsibility.
//
// These tests build a tiny fixture-based fake DB (see task-fixture-db.ts) that
// genuinely evaluates the query's where-condition against fixture rows, so
// they actually catch a regression that drops the accessible-pages filter —
// not just that a filter argument was present somewhere.
// ============================================================================

const h = vi.hoisted(() => ({
  tableRows: new Map<unknown, Record<string, unknown>[]>(),
  accessiblePageIds: [] as string[],
}));

vi.mock('@/lib/auth', () => ({
  authenticateRequestWithOptions: vi.fn(),
  isAuthError: vi.fn((r: unknown) => r != null && typeof r === 'object' && 'error' in r),
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
  const { createFixtureSelect } = await import('./task-fixture-db');
  return { db: { select: createFixtureSelect(h.tableRows, () => h.accessiblePageIds) } };
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
const PAGE_ID = 'page-1';

const mockAuth = () => ({
  userId: USER_ID,
  tokenVersion: 0,
  tokenType: 'session' as const,
  sessionId: 'sess-1',
  role: 'user' as const,
  adminRoleVersion: 0,
});

// An overdue task row (due before "today" = 2024-01-10).
const overdueTaskRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  assigneeId: USER_ID,
  userId: USER_ID,
  status: 'pending',
  dueDate: new Date('2024-01-05T00:00:00.000Z'),
  completedAt: null,
  priority: 'medium',
  pageId: PAGE_ID,
  ...overrides,
});

function setupTables(taskRows: Record<string, unknown>[], accessiblePageIds: string[]) {
  h.tableRows.clear();
  h.accessiblePageIds = accessiblePageIds;
  h.tableRows.set(users, [{ id: USER_ID, timezone: 'UTC' }]);
  h.tableRows.set(driveMembers, []);
  h.tableRows.set(taskItems, taskRows);
  h.tableRows.set(pulseSummaries, []);
  h.tableRows.set(dmConversations, []);
  // Every other table (calendarEvents, eventAttendees, pages) defaults to [] via
  // `tableRows.get(table) ?? []` in the fixture builder — no entry needed.
}

describe('GET /api/pulse — task counts scoped to accessible pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateRequestWithOptions).mockResolvedValue(mockAuth());
  });

  it('excludes an overdue task whose page is not accessible (trashed, or drive access revoked)', async () => {
    setupTables([overdueTaskRow()], [] /* PAGE_ID not accessible */);

    const response = await GET(new Request('https://example.com/api/pulse'));
    const body = await response.json();

    expect(body.stats.tasks.overdue).toBe(0);
  });

  it('counts a normal overdue task whose page is accessible', async () => {
    setupTables([overdueTaskRow()], [PAGE_ID]);

    const response = await GET(new Request('https://example.com/api/pulse'));
    const body = await response.json();

    expect(body.stats.tasks.overdue).toBe(1);
  });

  it('resolves task counts to 0 when the user has no accessible pages at all', async () => {
    setupTables([overdueTaskRow()], []); // would count if the filter were missing

    const response = await GET(new Request('https://example.com/api/pulse'));
    const body = await response.json();

    expect(body.stats.tasks).toEqual({
      overdue: 0,
      dueToday: 0,
      dueThisWeek: 0,
      completedThisWeek: 0,
    });
  });

  it('counts an overdue task in a drive the user owns but has no accepted membership row for yet', async () => {
    // Owner drive_members rows are only lazily backfilled on first access
    // (updateDriveLastAccessed). accessible_page_ids_for_user grants owner
    // access independent of that row, so the page is accessible regardless.
    setupTables([overdueTaskRow()], [PAGE_ID]);

    const response = await GET(new Request('https://example.com/api/pulse'));
    const body = await response.json();

    expect(body.stats.tasks.overdue).toBe(1);
  });

  it('counts an overdue task on a page shared via explicit permission with no drive membership', async () => {
    // A user can be assigned a task on a page shared directly with them
    // (page_permissions.canView) without ever being a drive member.
    // accessible_page_ids_for_user includes this; a driveId-based filter
    // could not, since there is no drive membership row at all.
    setupTables([overdueTaskRow()], [PAGE_ID]);

    const response = await GET(new Request('https://example.com/api/pulse'));
    const body = await response.json();

    expect(body.stats.tasks.overdue).toBe(1);
  });
});

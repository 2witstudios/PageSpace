// Fixture-DB tests for the Home signal queries (compute-signals.ts).
//
// Reuses the same generic where-condition-evaluating fixture harness as
// route.test.ts (task-fixture-db.ts) so these tests exercise the *real*
// where-clauses against fixture rows — not just that a filter argument was
// present somewhere. Each describe block seeds a control row that MUST be
// excluded, alongside the row that must be counted, so a regression that
// drops a filter turns a specific assertion red rather than just a count.
//
// The fixture harness treats a join as a structural no-op and expects the
// caller to hand it one already-flattened row per query, keyed by the mocked
// column-name strings below (not the real schema's field names — these are
// local aliases, consistent between the `vi.mock('@pagespace/db/schema/...')`
// calls and the seeded rows).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const tableRows = new Map<unknown, Record<string, unknown>[]>();

const notifications = { userId: 'userId', type: 'type', isRead: 'isRead', pageId: 'pageId', createdAt: 'createdAt' };
const taskItems = { id: 'id', assigneeId: 'assigneeId', status: 'status', dueDate: 'dueDate', pageId: 'pageId' };
const pages = { id: 'id', title: 'title', isTrashed: 'isTrashed', driveId: 'driveId' };
const eventAttendees = { userId: 'userId', status: 'status' };
const calendarEvents = {
  id: 'id',
  isTrashed: 'isTrashed',
  startAt: 'startAt',
  createdById: 'createdById',
  driveId: 'driveId',
  visibility: 'visibility',
};
const userPageViews = { userId: 'userId', pageId: 'pageId', viewedAt: 'viewedAt' };
const pageVersions = { pageId: 'pageId', driveId: 'driveId', createdAt: 'createdAt', createdBy: 'createdBy' };
const agentWorkspaces = { id: 'id', ownerId: 'ownerId', driveId: 'driveId', endedAt: 'endedAt' };
const drives = { id: 'id', name: 'name' };
const users = { id: 'id', name: 'name' };

vi.mock('@pagespace/db/db', async () => {
  const { createFixtureSelect } = await import('./task-fixture-db');
  const select = createFixtureSelect(tableRows);
  return { db: { select, selectDistinct: select } };
});

vi.mock('@pagespace/db/operators', async () => {
  const { fixtureOperators } = await import('./task-fixture-db');
  return fixtureOperators;
});

vi.mock('@pagespace/db/schema/notifications', () => ({ notifications }));
vi.mock('@pagespace/db/schema/tasks', () => ({ taskItems }));
vi.mock('@pagespace/db/schema/core', () => ({ pages, drives }));
vi.mock('@pagespace/db/schema/calendar', () => ({ eventAttendees, calendarEvents }));
vi.mock('@pagespace/db/schema/page-views', () => ({ userPageViews }));
vi.mock('@pagespace/db/schema/versioning', () => ({ pageVersions }));
vi.mock('@pagespace/db/schema/agent-workspaces', () => ({ agentWorkspaces }));
vi.mock('@pagespace/db/schema/auth', () => ({ users }));

const {
  computeMentionSignal,
  computeOverdueTaskSignal,
  computePendingInviteSignal,
  computeLeftOffSignal,
  computePagesChangedSignal,
  computeAgentFinishedSignal,
  computeFootprint,
} = await import('../compute-signals');

const NOW = new Date('2026-09-11T15:00:00Z');
const USER = 'user-1';

function seed(table: Record<string, string>, rows: Record<string, unknown>[]) {
  tableRows.set(table, rows);
}

beforeEach(() => {
  tableRows.clear();
});

describe('computeMentionSignal', () => {
  it('counts one unread mention and attaches the actor + page subject', async () => {
    seed(notifications, [
      { userId: USER, type: 'MENTION', isRead: false, pageId: 'p1', createdAt: NOW, name: 'Sarah', title: 'design-review', id: 'p1' },
    ]);
    const result = await computeMentionSignal(USER, NOW);
    expect(result.count).toBe(1);
    expect(result.text.lead).toBe('Sarah is waiting on you in design-review');
    expect(result.subject).toEqual({ type: 'page', id: 'p1', title: 'design-review' });
  });

  it('drops mentions belonging to another user (control row)', async () => {
    seed(notifications, [{ userId: 'other-user', type: 'MENTION', isRead: false, createdAt: NOW }]);
    const result = await computeMentionSignal(USER, NOW);
    expect(result.count).toBe(0);
  });

  it('drops already-read mentions (control row)', async () => {
    seed(notifications, [{ userId: USER, type: 'MENTION', isRead: true, createdAt: NOW }]);
    const result = await computeMentionSignal(USER, NOW);
    expect(result.count).toBe(0);
  });

  it('does not attach a subject when there is more than one mention', async () => {
    seed(notifications, [
      { userId: USER, type: 'MENTION', isRead: false, createdAt: NOW },
      { userId: USER, type: 'MENTION', isRead: false, createdAt: NOW },
    ]);
    const result = await computeMentionSignal(USER, NOW);
    expect(result.count).toBe(2);
    expect(result.subject).toBeUndefined();
    expect(result.text.lead).toBe('2 mentions');
  });
});

describe('computeOverdueTaskSignal', () => {
  const startOfToday = new Date('2026-09-11T00:00:00Z');
  const endOfToday = new Date('2026-09-12T00:00:00Z');

  it('counts a task assigned to the user that is overdue and accessible', async () => {
    seed(taskItems, [
      { id: 't1', assigneeId: USER, status: 'pending', dueDate: new Date('2026-09-10T00:00:00Z'), pageId: 'p1' },
    ]);
    const result = await computeOverdueTaskSignal(USER, ['p1'], startOfToday, endOfToday, NOW);
    expect(result.count).toBe(1);
  });

  it('excludes a task assigned to an agent the user owns but not to the user (control row)', async () => {
    seed(taskItems, [
      { id: 't1', assigneeId: 'agent-page-id', status: 'pending', dueDate: new Date('2026-09-10T00:00:00Z'), pageId: 'p1' },
    ]);
    const result = await computeOverdueTaskSignal(USER, ['p1'], startOfToday, endOfToday, NOW);
    expect(result.count).toBe(0);
  });

  it('excludes a task on a page the user can no longer access (control row)', async () => {
    seed(taskItems, [
      { id: 't1', assigneeId: USER, status: 'pending', dueDate: new Date('2026-09-10T00:00:00Z'), pageId: 'inaccessible-page' },
    ]);
    const result = await computeOverdueTaskSignal(USER, ['p1'], startOfToday, endOfToday, NOW);
    expect(result.count).toBe(0);
  });

  it('excludes completed tasks (control row)', async () => {
    seed(taskItems, [
      { id: 't1', assigneeId: USER, status: 'completed', dueDate: new Date('2026-09-10T00:00:00Z'), pageId: 'p1' },
    ]);
    const result = await computeOverdueTaskSignal(USER, ['p1'], startOfToday, endOfToday, NOW);
    expect(result.count).toBe(0);
  });
});

describe('computePendingInviteSignal', () => {
  it('counts a future pending invite the user did not organise', async () => {
    seed(eventAttendees, [
      { userId: USER, status: 'PENDING', isTrashed: false, startAt: new Date('2026-09-12T00:00:00Z'), createdById: 'organizer' },
    ]);
    const result = await computePendingInviteSignal(USER, NOW);
    expect(result.count).toBe(1);
  });

  it('excludes an event the user organised themselves (control row)', async () => {
    seed(eventAttendees, [
      { userId: USER, status: 'PENDING', isTrashed: false, startAt: new Date('2026-09-12T00:00:00Z'), createdById: USER },
    ]);
    const result = await computePendingInviteSignal(USER, NOW);
    expect(result.count).toBe(0);
  });

  it('excludes an already-accepted invite (control row)', async () => {
    seed(eventAttendees, [
      { userId: USER, status: 'ACCEPTED', isTrashed: false, startAt: new Date('2026-09-12T00:00:00Z'), createdById: 'organizer' },
    ]);
    const result = await computePendingInviteSignal(USER, NOW);
    expect(result.count).toBe(0);
  });
});

describe('computeLeftOffSignal', () => {
  // The fixture harness does not implement real ORDER BY (`orderBy` is a
  // structural no-op), so these seed the rows already in the order the
  // query's `orderBy(desc(viewedAt)).limit(1)` would produce — the ordering
  // itself is exercised by the real Drizzle query in production, not by
  // this fixture. The row NOT wanted goes second so a regression that drops
  // the `isTrashed` filter (the case below) still gets caught.
  it('returns the most recently viewed non-trashed page', async () => {
    seed(userPageViews, [
      { userId: USER, viewedAt: new Date('2026-09-10T00:00:00Z'), id: 'p-new', title: 'Trip planning', isTrashed: false },
      { userId: USER, viewedAt: new Date('2026-09-01T00:00:00Z'), id: 'p-old', title: 'Old page', isTrashed: false },
    ]);
    const result = await computeLeftOffSignal(USER, NOW);
    expect(result.count).toBe(1);
    expect(result.subject?.title).toBe('Trip planning');
  });

  it('falls back past a trashed most-recent view (control row)', async () => {
    seed(userPageViews, [
      { userId: USER, viewedAt: new Date('2026-09-10T00:00:00Z'), id: 'p-trashed', title: 'Trashed', isTrashed: true },
      { userId: USER, viewedAt: new Date('2026-09-05T00:00:00Z'), id: 'p-older', title: 'Older page', isTrashed: false },
    ]);
    const result = await computeLeftOffSignal(USER, NOW);
    expect(result.subject?.title).toBe('Older page');
  });
});

describe('computePagesChangedSignal', () => {
  const since = new Date('2026-09-10T00:00:00Z');

  it('counts a page changed by someone else in a drive the user uses', async () => {
    seed(pageVersions, [
      { pageId: 'p1', driveId: 'd1', createdAt: NOW, createdBy: 'sarah', title: 'Sessions redesign spec', name: 'Sarah', isTrashed: false },
    ]);
    const result = await computePagesChangedSignal(USER, ['d1'], since, NOW);
    expect(result.count).toBe(1);
    expect(result.text.lead).toBe('Sessions redesign spec changed by Sarah');
  });

  it('excludes a page the user edited themselves (control row)', async () => {
    seed(pageVersions, [
      { pageId: 'p1', driveId: 'd1', createdAt: NOW, createdBy: USER, title: 'My own edit', isTrashed: false },
    ]);
    const result = await computePagesChangedSignal(USER, ['d1'], since, NOW);
    expect(result.count).toBe(0);
  });

  it('excludes a drive not in drivesInUse even if accessible (control row)', async () => {
    seed(pageVersions, [
      { pageId: 'p1', driveId: 'd-not-used', createdAt: NOW, createdBy: 'sarah', title: 'Elsewhere', isTrashed: false },
    ]);
    const result = await computePagesChangedSignal(USER, ['d1'], since, NOW);
    expect(result.count).toBe(0);
  });
});

describe('computeAgentFinishedSignal', () => {
  const since = new Date('2026-09-10T00:00:00Z');

  it('counts a session the user owns that ended within the window', async () => {
    seed(agentWorkspaces, [{ id: 'w1', ownerId: USER, driveId: 'd1', endedAt: NOW, name: 'PageSpace' }]);
    const result = await computeAgentFinishedSignal(USER, since, NOW);
    expect(result.count).toBe(1);
    expect(result.subject?.title).toBe('PageSpace');
  });

  it('excludes a session that is still running — endedAt null (control row)', async () => {
    seed(agentWorkspaces, [{ id: 'w1', ownerId: USER, driveId: 'd1', endedAt: null }]);
    const result = await computeAgentFinishedSignal(USER, since, NOW);
    expect(result.count).toBe(0);
  });

  it('excludes a session owned by someone else (control row)', async () => {
    seed(agentWorkspaces, [{ id: 'w1', ownerId: 'other-user', driveId: 'd1', endedAt: NOW }]);
    const result = await computeAgentFinishedSignal(USER, since, NOW);
    expect(result.count).toBe(0);
  });
});

describe('computeFootprint', () => {
  it('returns null lastVisitAt and every accessible drive when the user has no page views', async () => {
    seed(userPageViews, []);
    const result = await computeFootprint(USER, ['d1', 'd2'], NOW);
    expect(result.lastVisitAt).toBeNull();
    expect(result.drivesInUse).toEqual(['d1', 'd2']);
  });

  it('excludes a drive the user can no longer access (control row)', async () => {
    seed(userPageViews, [{ userId: USER, viewedAt: NOW, driveId: 'd-revoked', isTrashed: false }]);
    const result = await computeFootprint(USER, ['d1'], NOW); // d-revoked is not in the accessible driveIds
    expect(result.drivesInUse).not.toContain('d-revoked');
  });
});

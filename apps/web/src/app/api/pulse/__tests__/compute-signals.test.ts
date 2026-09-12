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
  // A real distinct implementation, not aliased to `select` — see
  // computePagesChangedSignal's "two editors, one page" test below, which
  // only means anything with genuine dedup behavior here.
  const selectDistinct = createFixtureSelect(tableRows, { distinct: true });
  return { db: { select, selectDistinct } };
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
    const result = await computeMentionSignal(USER, ['p1'], NOW);
    expect(result.count).toBe(1);
    expect(result.text.lead).toBe('Sarah is waiting on you in design-review');
    expect(result.subject).toEqual({ type: 'page', id: 'p1', title: 'design-review' });
  });

  it('drops mentions belonging to another user (control row)', async () => {
    seed(notifications, [{ userId: 'other-user', type: 'MENTION', isRead: false, createdAt: NOW }]);
    const result = await computeMentionSignal(USER, ['p1'], NOW);
    expect(result.count).toBe(0);
  });

  it('drops already-read mentions (control row)', async () => {
    seed(notifications, [{ userId: USER, type: 'MENTION', isRead: true, createdAt: NOW }]);
    const result = await computeMentionSignal(USER, ['p1'], NOW);
    expect(result.count).toBe(0);
  });

  it('does not attach a subject when there is more than one mention', async () => {
    seed(notifications, [
      { userId: USER, type: 'MENTION', isRead: false, createdAt: NOW },
      { userId: USER, type: 'MENTION', isRead: false, createdAt: NOW },
    ]);
    const result = await computeMentionSignal(USER, ['p1'], NOW);
    expect(result.count).toBe(2);
    expect(result.subject).toBeUndefined();
    expect(result.text.lead).toBe('2 mentions');
  });

  it('excludes a mention on a page access to which has been revoked (control row)', async () => {
    seed(notifications, [
      { userId: USER, type: 'MENTION', isRead: false, pageId: 'revoked-page', createdAt: NOW },
    ]);
    const result = await computeMentionSignal(USER, ['p1'], NOW); // 'revoked-page' not accessible
    expect(result.count).toBe(0);
  });

  it('still counts a mention that carries no pageId at all', async () => {
    seed(notifications, [{ userId: USER, type: 'MENTION', isRead: false, createdAt: NOW }]);
    const result = await computeMentionSignal(USER, ['p1'], NOW);
    expect(result.count).toBe(1);
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

  it('returns zero, not every matching task, when accessiblePageIds is empty (control row)', async () => {
    // A ternary that falls back to `undefined` for the empty case would drop
    // the page filter from the query entirely instead of denying all — this
    // seeds a task whose page is NOT in (an empty) accessiblePageIds and
    // asserts it is still excluded, the way it would be with any non-empty
    // list that doesn't contain 'p1'.
    seed(taskItems, [
      { id: 't1', assigneeId: USER, status: 'pending', dueDate: new Date('2026-09-10T00:00:00Z'), pageId: 'p1' },
    ]);
    const result = await computeOverdueTaskSignal(USER, [], startOfToday, endOfToday, NOW);
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
  it('returns the most recently viewed non-trashed, accessible page', async () => {
    seed(userPageViews, [
      { userId: USER, viewedAt: new Date('2026-09-10T00:00:00Z'), id: 'p-new', title: 'Trip planning', isTrashed: false },
      { userId: USER, viewedAt: new Date('2026-09-01T00:00:00Z'), id: 'p-old', title: 'Old page', isTrashed: false },
    ]);
    const result = await computeLeftOffSignal(USER, ['p-new', 'p-old'], NOW);
    expect(result.count).toBe(1);
    expect(result.subject?.title).toBe('Trip planning');
  });

  it('falls back past a trashed most-recent view (control row)', async () => {
    seed(userPageViews, [
      { userId: USER, viewedAt: new Date('2026-09-10T00:00:00Z'), id: 'p-trashed', title: 'Trashed', isTrashed: true },
      { userId: USER, viewedAt: new Date('2026-09-05T00:00:00Z'), id: 'p-older', title: 'Older page', isTrashed: false },
    ]);
    const result = await computeLeftOffSignal(USER, ['p-trashed', 'p-older'], NOW);
    expect(result.subject?.title).toBe('Older page');
  });

  it('falls back past a most-recent view whose access has been revoked (control row)', async () => {
    seed(userPageViews, [
      { userId: USER, viewedAt: new Date('2026-09-10T00:00:00Z'), id: 'p-revoked', title: 'No longer accessible', isTrashed: false },
      { userId: USER, viewedAt: new Date('2026-09-05T00:00:00Z'), id: 'p-still-ok', title: 'Still accessible', isTrashed: false },
    ]);
    // 'p-revoked' is deliberately absent from accessiblePageIds.
    const result = await computeLeftOffSignal(USER, ['p-still-ok'], NOW);
    expect(result.subject?.title).toBe('Still accessible');
  });

  it('returns the quiet count when the user has no accessible pages at all', async () => {
    seed(userPageViews, [
      { userId: USER, viewedAt: NOW, id: 'p1', title: 'Anything', isTrashed: false },
    ]);
    const result = await computeLeftOffSignal(USER, [], NOW);
    expect(result.count).toBe(0);
  });
});

describe('computePagesChangedSignal', () => {
  const since = new Date('2026-09-10T00:00:00Z');

  it('counts a page changed by someone else in a drive the user uses', async () => {
    seed(pageVersions, [
      { pageId: 'p1', driveId: 'd1', createdAt: NOW, createdBy: 'sarah', title: 'Sessions redesign spec', name: 'Sarah', isTrashed: false },
    ]);
    const result = await computePagesChangedSignal(USER, ['p1'], ['d1'], since, NOW);
    expect(result.count).toBe(1);
    expect(result.text.lead).toBe('Sessions redesign spec changed by Sarah');
  });

  it('excludes a page the user edited themselves (control row)', async () => {
    seed(pageVersions, [
      { pageId: 'p1', driveId: 'd1', createdAt: NOW, createdBy: USER, title: 'My own edit', isTrashed: false },
    ]);
    const result = await computePagesChangedSignal(USER, ['p1'], ['d1'], since, NOW);
    expect(result.count).toBe(0);
  });

  it('excludes a drive not in drivesInUse even if accessible (control row)', async () => {
    seed(pageVersions, [
      { pageId: 'p1', driveId: 'd-not-used', createdAt: NOW, createdBy: 'sarah', title: 'Elsewhere', isTrashed: false },
    ]);
    const result = await computePagesChangedSignal(USER, ['p1'], ['d1'], since, NOW);
    expect(result.count).toBe(0);
  });

  it('excludes a page in a used drive that the user has no per-page access to (control row)', async () => {
    // A private page inside a drive the user belongs to — drive membership
    // alone must not be enough to surface it or its editor's identity.
    seed(pageVersions, [
      { pageId: 'private-page', driveId: 'd1', createdAt: NOW, createdBy: 'sarah', title: 'Private page', name: 'Sarah', isTrashed: false },
    ]);
    const result = await computePagesChangedSignal(USER, ['some-other-page'], ['d1'], since, NOW);
    expect(result.count).toBe(0);
  });

  it('counts one page, not one row per editor, when two people changed the same page', async () => {
    // selectDistinct on (pageId, title, actor) would treat these as two
    // distinct rows — the fix selects distinct pageId alone.
    seed(pageVersions, [
      { pageId: 'p1', driveId: 'd1', createdAt: NOW, createdBy: 'sarah', title: 'Shared doc', name: 'Sarah', isTrashed: false },
      { pageId: 'p1', driveId: 'd1', createdAt: NOW, createdBy: 'marcus', title: 'Shared doc', name: 'Marcus', isTrashed: false },
    ]);
    const result = await computePagesChangedSignal(USER, ['p1'], ['d1'], since, NOW);
    expect(result.count).toBe(1);
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

  it('returns an empty footprint, not an unscoped one, when driveIds is empty (control row)', async () => {
    // Same fail-open shape as the task-signal test above: a ternary
    // fallback to `undefined` for the empty case would drop the driveId
    // filter entirely and walk every page view the user has ever made.
    seed(userPageViews, [{ userId: USER, viewedAt: NOW, driveId: 'any-drive', isTrashed: false }]);
    const result = await computeFootprint(USER, [], NOW);
    expect(result.drivesInUse).toEqual([]);
    expect(result.lastVisitAt).toBeNull();
  });
});

/**
 * Computes the Home {@link Signal}[] behind `/api/pulse`: facts addressed to
 * the user, their footprint (where they've been), and things they own
 * (agent sessions). See `packages/lib/src/home-signals` for the pure
 * ranking/composition side — this file is the only place that talks to the
 * database.
 *
 * Every query here is scoped to `accessiblePageIds` / `driveIds` the caller
 * already computed (the same primitives the rest of this route uses), so a
 * signal can never leak a fact the user has lost access to.
 */
import { and, count, desc, eq, gte, inArray, isNull, lt, ne, or } from '@pagespace/db/operators';
import { db } from '@pagespace/db/db';
import { agentWorkspaces } from '@pagespace/db/schema/agent-workspaces';
import { calendarEvents, eventAttendees } from '@pagespace/db/schema/calendar';
import { pages, drives } from '@pagespace/db/schema/core';
import { notifications } from '@pagespace/db/schema/notifications';
import { userPageViews } from '@pagespace/db/schema/page-views';
import { pageVersions } from '@pagespace/db/schema/versioning';
import { taskItems } from '@pagespace/db/schema/tasks';
import { users } from '@pagespace/db/schema/auth';
import type { Signal } from '@pagespace/lib/home-signals/types';

const DASHBOARD_HOME_DAYS_BACK = 60; // recency window for "drives you use"
const MAX_RECENT_VIEWS = 50;

/** Builds {@link HomeContext.drivesInUse} and {@link HomeContext.lastVisitAt}. */
export async function computeFootprint(
  userId: string,
  driveIds: string[],
  now: Date = new Date(),
): Promise<{ drivesInUse: string[]; lastVisitAt: Date | null }> {
  const since = new Date(now.getTime() - DASHBOARD_HOME_DAYS_BACK * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ driveId: pages.driveId, viewedAt: userPageViews.viewedAt })
    .from(userPageViews)
    .innerJoin(pages, eq(pages.id, userPageViews.pageId))
    .where(
      and(
        eq(userPageViews.userId, userId),
        gte(userPageViews.viewedAt, since),
        eq(pages.isTrashed, false),
        driveIds.length > 0 ? inArray(pages.driveId, driveIds) : undefined,
      ),
    )
    .orderBy(desc(userPageViews.viewedAt))
    .limit(MAX_RECENT_VIEWS);

  const drivesInUse = [...new Set(rows.map((r) => r.driveId).filter((d): d is string => d !== null))];
  const lastVisitAt = rows[0]?.viewedAt ?? null;
  return { drivesInUse: drivesInUse.length > 0 ? drivesInUse : driveIds, lastVisitAt };
}

/**
 * A notification can outlive the user's access to the page it points at
 * (permission revoked, drive membership removed, page trashed after the
 * notification was created). `pageId` is nullable on some notification
 * types, so a null page is let through unfiltered — only a *set* pageId is
 * checked against `accessiblePageIds`, the same set the rest of this route
 * already treats as the source of truth for "can this user actually open
 * this page right now".
 */
function notificationPageAccessClause(accessiblePageIds: string[]) {
  return accessiblePageIds.length > 0
    ? or(isNull(notifications.pageId), inArray(notifications.pageId, accessiblePageIds))
    : isNull(notifications.pageId);
}

export async function computeMentionSignal(
  userId: string,
  accessiblePageIds: string[],
  now: Date,
): Promise<Signal> {
  const whereClause = and(
    eq(notifications.userId, userId),
    eq(notifications.type, 'MENTION'),
    eq(notifications.isRead, false),
    notificationPageAccessClause(accessiblePageIds),
  );

  const rows = await db.select({ count: count() }).from(notifications).where(whereClause);
  const total = rows[0]?.count ?? 0;

  let leadText = `${total} mentions`;
  let shortText = `${total} mentions`;
  let subject: Signal['subject'];
  if (total === 1) {
    const [row] = await db
      .select({ actorName: users.name, pageTitle: pages.title, pageId: pages.id })
      .from(notifications)
      .leftJoin(users, eq(users.id, notifications.triggeredByUserId))
      .leftJoin(pages, eq(pages.id, notifications.pageId))
      .where(whereClause)
      .orderBy(desc(notifications.createdAt))
      .limit(1);
    if (row?.actorName && row.pageTitle) {
      leadText = `${row.actorName} is waiting on you in ${row.pageTitle}`;
      shortText = `${row.actorName} in ${row.pageTitle}`;
      subject = { type: 'page', id: row.pageId ?? '', title: row.pageTitle };
    } else if (row?.actorName) {
      leadText = `${row.actorName} mentioned you`;
      shortText = `${row.actorName} mentioned you`;
      subject = { type: 'user', id: '', title: row.actorName };
    }
  }

  return {
    kind: 'mention',
    count: total,
    subject,
    window: { since: now, kind: 'today' },
    computedAt: now,
    text: { lead: leadText, short: shortText },
    action: { prompt: total === 1 ? 'Reply to that' : 'Catch up on my mentions' },
  };
}

interface TaskCountRow {
  count: number;
}

async function computeTaskSignal(
  kind: 'overdue_task' | 'due_today',
  userId: string,
  accessiblePageIds: string[],
  startOfToday: Date,
  endOfToday: Date,
  now: Date,
): Promise<Signal> {
  const isOverdue = kind === 'overdue_task';
  const dueClause = isOverdue
    ? lt(taskItems.dueDate, startOfToday)
    : and(gte(taskItems.dueDate, startOfToday), lt(taskItems.dueDate, endOfToday));
  const whereClause = and(
    eq(taskItems.assigneeId, userId),
    ne(taskItems.status, 'completed'),
    dueClause,
    accessiblePageIds.length > 0 ? inArray(taskItems.pageId, accessiblePageIds) : undefined,
  );

  const [row]: TaskCountRow[] = await db.select({ count: count() }).from(taskItems).where(whereClause);
  const total = row?.count ?? 0;

  let leadText = isOverdue ? `${total} tasks overdue` : `${total} tasks due today`;
  let shortText = leadText;
  let subject: Signal['subject'];
  if (total === 1) {
    // A task item has no title of its own — it links 1:1 to the TASK_LIST
    // page that names it, so the title comes from `pages.title`.
    const [task] = await db
      .select({ id: taskItems.id, title: pages.title })
      .from(taskItems)
      .innerJoin(pages, eq(pages.id, taskItems.pageId))
      .where(whereClause)
      .limit(1);
    if (task) {
      leadText = isOverdue ? `${task.title} is overdue` : `${task.title} is due today`;
      shortText = task.title;
      subject = { type: 'page', id: task.id, title: task.title };
    }
  }

  return {
    kind,
    count: total,
    subject,
    window: { since: startOfToday, kind: 'today' },
    computedAt: now,
    text: { lead: leadText, short: shortText },
    action: { prompt: isOverdue ? 'What is overdue?' : 'What is due today?' },
  };
}

export const computeOverdueTaskSignal = (
  userId: string,
  accessiblePageIds: string[],
  startOfToday: Date,
  endOfToday: Date,
  now: Date,
) => computeTaskSignal('overdue_task', userId, accessiblePageIds, startOfToday, endOfToday, now);

export const computeDueTodaySignal = (
  userId: string,
  accessiblePageIds: string[],
  startOfToday: Date,
  endOfToday: Date,
  now: Date,
) => computeTaskSignal('due_today', userId, accessiblePageIds, startOfToday, endOfToday, now);

export async function computePendingInviteSignal(userId: string, now: Date): Promise<Signal> {
  const [row] = await db
    .select({ count: count() })
    .from(eventAttendees)
    .innerJoin(calendarEvents, eq(calendarEvents.id, eventAttendees.eventId))
    .where(
      and(
        eq(eventAttendees.userId, userId),
        eq(eventAttendees.status, 'PENDING'),
        eq(calendarEvents.isTrashed, false),
        gte(calendarEvents.startAt, now),
        ne(calendarEvents.createdById, userId),
      ),
    );
  const total = row?.count ?? 0;
  return {
    kind: 'pending_invite',
    count: total,
    window: { since: now, kind: 'today' },
    computedAt: now,
    text: { lead: `${total} invites need an RSVP`, short: `${total} invites` },
    action: { prompt: 'Sort the invites' },
  };
}

export async function computeMeetingTodaySignal(
  userId: string,
  driveIds: string[],
  startOfToday: Date,
  endOfToday: Date,
  now: Date,
): Promise<Signal> {
  const visibility =
    driveIds.length > 0
      ? or(
          and(isNull(calendarEvents.driveId), eq(calendarEvents.createdById, userId)),
          and(inArray(calendarEvents.driveId, driveIds), or(eq(calendarEvents.visibility, 'DRIVE'), eq(calendarEvents.createdById, userId))),
        )
      : and(isNull(calendarEvents.driveId), eq(calendarEvents.createdById, userId));

  const [row] = await db
    .select({ count: count() })
    .from(calendarEvents)
    .where(
      and(eq(calendarEvents.isTrashed, false), gte(calendarEvents.startAt, now), lt(calendarEvents.startAt, endOfToday), visibility),
    );
  const total = row?.count ?? 0;
  return {
    kind: 'meeting_today',
    count: total,
    window: { since: startOfToday, kind: 'today' },
    computedAt: now,
    text: { lead: `${total} meetings today`, short: `${total} meetings today` },
    action: { prompt: 'Plan today' },
  };
}

export async function computeLeftOffSignal(
  userId: string,
  accessiblePageIds: string[],
  now: Date,
): Promise<Signal> {
  // A page view can outlive access to the page (permission revoked, drive
  // membership removed after the visit) — scope to accessiblePageIds so
  // "where you left off" never discloses a title/link the user can no
  // longer open.
  if (accessiblePageIds.length === 0) {
    return {
      kind: 'left_off',
      count: 0,
      window: { since: now, kind: 'today' },
      computedAt: now,
      text: { lead: '', short: '' },
      action: {},
    };
  }

  const [row] = await db
    .select({ pageId: pages.id, title: pages.title })
    .from(userPageViews)
    .innerJoin(pages, eq(pages.id, userPageViews.pageId))
    .where(
      and(
        eq(userPageViews.userId, userId),
        eq(pages.isTrashed, false),
        inArray(pages.id, accessiblePageIds),
      ),
    )
    .orderBy(desc(userPageViews.viewedAt))
    .limit(1);

  if (!row) {
    return {
      kind: 'left_off',
      count: 0,
      window: { since: now, kind: 'today' },
      computedAt: now,
      text: { lead: '', short: '' },
      action: {},
    };
  }
  return {
    kind: 'left_off',
    count: 1,
    subject: { type: 'page', id: row.pageId, title: row.title },
    window: { since: now, kind: 'today' },
    computedAt: now,
    text: { lead: `you left off in ${row.title}`, short: `you left off in ${row.title}` },
    action: { prompt: `Pick up ${row.title}`, href: `/pages/${row.pageId}` },
  };
}

/**
 * Pages changed by someone OTHER than the user, in drives the user actually
 * visits (`drivesInUse`), since `since`. Uses `page_versions.createdBy`
 * (the only actor-attributed edit record) rather than `pages.updatedAt`,
 * which carries no actor.
 *
 * `drivesInUse` alone is NOT an access-control boundary — drive membership
 * does not imply per-page access (a drive can hold private pages the user
 * was never granted). `accessiblePageIds` is additionally required so this
 * signal can never name a page, or its editor, the user cannot open.
 */
export async function computePagesChangedSignal(
  userId: string,
  accessiblePageIds: string[],
  drivesInUse: string[],
  since: Date,
  now: Date,
): Promise<Signal> {
  if (drivesInUse.length === 0 || accessiblePageIds.length === 0) {
    return {
      kind: 'pages_changed',
      count: 0,
      window: { since, kind: 'today' },
      computedAt: now,
      text: { lead: '', short: '' },
      action: {},
    };
  }

  const rows = await db
    .selectDistinct({ pageId: pageVersions.pageId, pageTitle: pages.title, actorName: users.name })
    .from(pageVersions)
    .innerJoin(pages, eq(pages.id, pageVersions.pageId))
    .leftJoin(users, eq(users.id, pageVersions.createdBy))
    .where(
      and(
        inArray(pageVersions.driveId, drivesInUse),
        inArray(pageVersions.pageId, accessiblePageIds),
        gte(pageVersions.createdAt, since),
        ne(pageVersions.createdBy, userId),
        eq(pages.isTrashed, false),
      ),
    )
    .limit(50);

  const total = rows.length;
  let leadText = `${total} pages changed`;
  let shortText = `${total} pages changed`;
  let subject: Signal['subject'];
  if (total === 1 && rows[0]) {
    const [row] = rows;
    leadText = row.actorName ? `${row.pageTitle} changed by ${row.actorName}` : `${row.pageTitle} changed`;
    shortText = row.pageTitle;
    subject = { type: 'page', id: row.pageId, title: row.pageTitle };
  }

  return {
    kind: 'pages_changed',
    count: total,
    subject,
    window: { since, kind: 'today' },
    computedAt: now,
    text: { lead: leadText, short: shortText },
    action: { prompt: 'What changed since yesterday?' },
  };
}

/**
 * Agent sessions the user owns that finished inside the window, across every
 * drive and global-assistant sessions alike (`driveId` is nullable there).
 * There is no cross-drive "needs review" signal yet — every finished session
 * counts the same; that distinction is a known gap, not modelled here.
 */
export async function computeAgentFinishedSignal(userId: string, since: Date, now: Date): Promise<Signal> {
  const rows = await db
    .select({ id: agentWorkspaces.id, driveId: agentWorkspaces.driveId, driveName: drives.name })
    .from(agentWorkspaces)
    .leftJoin(drives, eq(drives.id, agentWorkspaces.driveId))
    .where(and(eq(agentWorkspaces.ownerId, userId), gte(agentWorkspaces.endedAt, since)))
    .limit(50);

  const total = rows.length;
  let leadText = `${total} agent sessions finished`;
  let shortText = `${total} sessions finished`;
  let subject: Signal['subject'];
  if (total === 1 && rows[0]) {
    const [row] = rows;
    const where = row.driveName ?? 'Global Assistant';
    leadText = `An agent session finished in ${where}`;
    shortText = '1 session finished';
    subject = { type: 'session', id: row.id, title: where };
  }

  return {
    kind: 'agent_finished',
    count: total,
    subject,
    window: { since, kind: 'today' },
    computedAt: now,
    text: { lead: leadText, short: shortText },
    action: { prompt: 'Review the finished sessions' },
  };
}

export function unreadDmSignal(unreadCount: number, now: Date): Signal {
  return {
    kind: 'unread_dm',
    count: unreadCount,
    window: { since: now, kind: 'today' },
    computedAt: now,
    text: { lead: `${unreadCount} unread messages`, short: `${unreadCount} unread` },
    action: { prompt: 'Catch up on my messages' },
  };
}

export function pulseSummarySignal(
  summary: { text: string; isStale: boolean } | null,
  now: Date,
): Signal {
  if (!summary || summary.isStale) {
    return {
      kind: 'pulse_summary',
      count: 0,
      window: { since: now, kind: 'today' },
      computedAt: now,
      text: { lead: '', short: '' },
      action: {},
    };
  }
  return {
    kind: 'pulse_summary',
    count: 1,
    window: { since: now, kind: 'today' },
    computedAt: now,
    text: { lead: summary.text, short: summary.text },
    action: {},
  };
}

export interface ComputeAllSignalsArgs {
  userId: string;
  accessiblePageIds: string[];
  driveIds: string[];
  drivesInUse: string[];
  unreadDmCount: number;
  summary: { text: string; isStale: boolean } | null;
  now: Date;
  startOfToday: Date;
  endOfToday: Date;
  sinceWindowStart: Date;
}

export async function computeAllSignals(args: ComputeAllSignalsArgs): Promise<Signal[]> {
  const {
    userId,
    accessiblePageIds,
    driveIds,
    drivesInUse,
    unreadDmCount,
    summary,
    now,
    startOfToday,
    endOfToday,
    sinceWindowStart,
  } = args;

  const [mention, overdue, dueToday, invite, meeting, leftOff, pagesChanged, agentFinished] = await Promise.all([
    computeMentionSignal(userId, accessiblePageIds, now),
    computeOverdueTaskSignal(userId, accessiblePageIds, startOfToday, endOfToday, now),
    computeDueTodaySignal(userId, accessiblePageIds, startOfToday, endOfToday, now),
    computePendingInviteSignal(userId, now),
    computeMeetingTodaySignal(userId, driveIds, startOfToday, endOfToday, now),
    computeLeftOffSignal(userId, accessiblePageIds, now),
    computePagesChangedSignal(userId, accessiblePageIds, drivesInUse, sinceWindowStart, now),
    computeAgentFinishedSignal(userId, sinceWindowStart, now),
  ]);

  return [
    mention,
    overdue,
    dueToday,
    invite,
    meeting,
    leftOff,
    pagesChanged,
    agentFinished,
    unreadDmSignal(unreadDmCount, now),
    pulseSummarySignal(summary, now),
  ];
}

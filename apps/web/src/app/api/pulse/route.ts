import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db } from '@pagespace/db/db'
import { eq, and, or, lt, gte, ne, desc, count, inArray, isNull, isNotNull, sql } from '@pagespace/db/operators'
import { users } from '@pagespace/db/schema/auth'
import { pages } from '@pagespace/db/schema/core'
import { driveMembers } from '@pagespace/db/schema/members'
import { taskItems } from '@pagespace/db/schema/tasks'
import { calendarEvents, eventAttendees } from '@pagespace/db/schema/calendar'
import { directMessages, dmConversations } from '@pagespace/db/schema/social'
import { pulseSummaries } from '@pagespace/db/schema/dashboard';
import { userAutomationPreferences } from '@pagespace/db/schema/automation-preferences';
import { resolvePulseEnabled } from '@pagespace/lib/billing/automation-preferences';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getStartOfTodayInTimezone, normalizeTimezone } from '@/lib/ai/core/timestamp-utils';

const AUTH_OPTIONS = { allow: ['session'] as const };

// Re-export types for client consumption
export type PulseResponse = {
  // AI-generated summary (may be null if no recent summary)
  summary: {
    id: string;
    text: string;
    greeting: string | null;
    generatedAt: Date;
    expiresAt: Date;
    isStale: boolean; // True if older than 6 hours
  } | null;

  // Real-time stats (always fresh)
  stats: {
    tasks: {
      dueToday: number;
      dueThisWeek: number;
      overdue: number;
      completedThisWeek: number;
    };
    messages: {
      unreadCount: number;
    };
    pages: {
      updatedToday: number;
      updatedThisWeek: number;
    };
    calendar: {
      upcomingToday: number;
      pendingInvites: number;
    };
  };

  // Should the client request a new summary?
  shouldRefresh: boolean;
};

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    const now = new Date();
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);

    // Get user timezone for accurate "today" boundaries
    const [user] = await db.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId));
    const userTimezone = normalizeTimezone(user?.timezone);

    // Whether the user has Pulse enabled (opt-out: no row ⇒ enabled). When off, we
    // never tell the client to auto-generate, so no credits are spent on Pulse.
    const [pulsePref] = await db
      .select({ pulseEnabled: userAutomationPreferences.pulseEnabled })
      .from(userAutomationPreferences)
      .where(eq(userAutomationPreferences.userId, userId));
    const pulseEnabled = resolvePulseEnabled(pulsePref);
    const startOfToday = getStartOfTodayInTimezone(userTimezone);
    const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

    // Week boundaries (Sunday start) in user's timezone
    // Determine user's local day-of-week from startOfToday
    const userLocalDay = new Intl.DateTimeFormat('en-US', { timeZone: userTimezone, weekday: 'short' }).format(now);
    const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayOfWeek = dayMap[userLocalDay] ?? 0;
    const startOfWeek = new Date(startOfToday.getTime() - dayOfWeek * 24 * 60 * 60 * 1000);
    const endOfWeek = new Date(startOfWeek.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Phase 1: Fire all independent queries in parallel
    // Summary, drives, and conversations are all independent. Task counts depend
    // on driveIds (to scope by membership and exclude trashed pages), so they
    // move to Phase 2 below.
    const [
      summaryResult,
      userDrives,
      userConversations,
    ] = await Promise.all([
      // Latest pulse summary
      db.select()
        .from(pulseSummaries)
        .where(eq(pulseSummaries.userId, userId))
        .orderBy(desc(pulseSummaries.generatedAt))
        .limit(1),
      // User's drives
      db.select({ driveId: driveMembers.driveId })
        .from(driveMembers)
        .where(and(
          eq(driveMembers.userId, userId),
          isNotNull(driveMembers.acceptedAt)
        )),
      // User conversations
      db.select({ id: dmConversations.id })
        .from(dmConversations)
        .where(
          or(
            eq(dmConversations.participant1Id, userId),
            eq(dmConversations.participant2Id, userId)
          )
        ),
    ]);

    const latestSummary = summaryResult[0] ?? null;
    const driveIds = userDrives.map(d => d.driveId);
    // Task scoping uses the canonical accessible_page_ids_for_user DB function
    // rather than driveIds: it already covers owner access (no accepted
    // drive_members row required — that row is only lazily backfilled on first
    // drive access), drive-admin/member access, explicit page-level permission
    // grants (a user can be assigned a task on a page shared with them directly,
    // with no drive membership at all), and excludes trashed pages AND pages in
    // trashed drives. A driveId-based filter can't express any of that without
    // reimplementing this function's rules by hand.

    // Phase 2: Queries that depend on driveIds or conversationIds
    const calendarVisibility = driveIds.length > 0
      ? or(
          and(isNull(calendarEvents.driveId), eq(calendarEvents.createdById, userId)),
          and(
            inArray(calendarEvents.driveId, driveIds),
            or(
              eq(calendarEvents.visibility, 'DRIVE'),
              eq(calendarEvents.createdById, userId)
            )
          )
        )
      : and(isNull(calendarEvents.driveId), eq(calendarEvents.createdById, userId));

    const conversationIds = userConversations.map(c => c.id);

    const [
      unreadResult,
      upcomingTodayArr,
      pendingInvitesArr,
      pagesTodayArr,
      pagesWeekArr,
      tasksOverdueResult,
      tasksDueTodayResult,
      tasksDueThisWeekResult,
      tasksCompletedThisWeekResult,
    ] = await Promise.all([
      // Unread messages — exclude thread replies (parentId IS NOT NULL) so the
      // pulse unread count matches the inbox unread count. Thread replies live
      // in the panel; PR 5 will reintroduce per-follower thread bumps.
      conversationIds.length > 0
        ? db.select({ count: count() })
            .from(directMessages)
            .where(
              and(
                inArray(directMessages.conversationId, conversationIds),
                ne(directMessages.senderId, userId),
                eq(directMessages.isRead, false),
                eq(directMessages.isActive, true),
                isNull(directMessages.parentId)
              )
            )
        : Promise.resolve([{ count: 0 }]),
      // Calendar events today
      db.select({ count: count() })
        .from(calendarEvents)
        .where(
          and(
            eq(calendarEvents.isTrashed, false),
            gte(calendarEvents.startAt, now),
            lt(calendarEvents.startAt, endOfToday),
            calendarVisibility
          )
        ),
      // Pending invites
      db.select({ count: count() })
        .from(eventAttendees)
        .innerJoin(calendarEvents, eq(calendarEvents.id, eventAttendees.eventId))
        .where(
          and(
            eq(eventAttendees.userId, userId),
            eq(eventAttendees.status, 'PENDING'),
            eq(calendarEvents.isTrashed, false),
            gte(calendarEvents.startAt, now),
          )
        ),
      // Pages updated today
      driveIds.length > 0
        ? db.select({ count: count() })
            .from(pages)
            .where(
              and(
                inArray(pages.driveId, driveIds),
                eq(pages.isTrashed, false),
                gte(pages.updatedAt, startOfToday)
              )
            )
        : Promise.resolve([{ count: 0 }]),
      // Pages updated this week
      driveIds.length > 0
        ? db.select({ count: count() })
            .from(pages)
            .where(
              and(
                inArray(pages.driveId, driveIds),
                eq(pages.isTrashed, false),
                gte(pages.updatedAt, startOfWeek)
              )
            )
        : Promise.resolve([{ count: 0 }]),
      // Tasks overdue
      db.select({ count: count() })
        .from(taskItems)
        .where(
          and(
            or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
            ne(taskItems.status, 'completed'),
            lt(taskItems.dueDate, startOfToday),
            sql`${taskItems.pageId} IN (SELECT page_id FROM accessible_page_ids_for_user(${userId}))`
          )
        ),
      // Tasks due today
      db.select({ count: count() })
        .from(taskItems)
        .where(
          and(
            or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
            ne(taskItems.status, 'completed'),
            gte(taskItems.dueDate, startOfToday),
            lt(taskItems.dueDate, endOfToday),
            sql`${taskItems.pageId} IN (SELECT page_id FROM accessible_page_ids_for_user(${userId}))`
          )
        ),
      // Tasks due this week
      db.select({ count: count() })
        .from(taskItems)
        .where(
          and(
            or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
            ne(taskItems.status, 'completed'),
            gte(taskItems.dueDate, startOfToday),
            lt(taskItems.dueDate, endOfWeek),
            sql`${taskItems.pageId} IN (SELECT page_id FROM accessible_page_ids_for_user(${userId}))`
          )
        ),
      // Tasks completed this week
      db.select({ count: count() })
        .from(taskItems)
        .where(
          and(
            or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
            eq(taskItems.status, 'completed'),
            gte(taskItems.completedAt, startOfWeek),
            sql`${taskItems.pageId} IN (SELECT page_id FROM accessible_page_ids_for_user(${userId}))`
          )
        ),
    ]);

    const unreadCount = unreadResult[0]?.count ?? 0;
    const [upcomingTodayResult] = upcomingTodayArr;
    const [pendingInvitesResult] = pendingInvitesArr;
    const pagesUpdatedToday = pagesTodayArr[0]?.count ?? 0;
    const pagesUpdatedThisWeek = pagesWeekArr[0]?.count ?? 0;
    const [tasksOverdue] = tasksOverdueResult;
    const [tasksDueToday] = tasksDueTodayResult;
    const [tasksDueThisWeek] = tasksDueThisWeekResult;
    const [tasksCompletedThisWeek] = tasksCompletedThisWeekResult;

    // Determine if summary is stale
    const isStale = latestSummary
      ? new Date(latestSummary.generatedAt).getTime() < sixHoursAgo.getTime()
      : true;

    // Determine if client should refresh — never when the user disabled Pulse.
    const shouldRefresh = pulseEnabled && (!latestSummary || isStale);

    const response: PulseResponse = {
      summary: latestSummary
        ? {
            id: latestSummary.id,
            text: latestSummary.summary,
            greeting: latestSummary.greeting,
            generatedAt: latestSummary.generatedAt,
            expiresAt: latestSummary.expiresAt,
            isStale,
          }
        : null,
      stats: {
        tasks: {
          dueToday: tasksDueToday?.count ?? 0,
          dueThisWeek: tasksDueThisWeek?.count ?? 0,
          overdue: tasksOverdue?.count ?? 0,
          completedThisWeek: tasksCompletedThisWeek?.count ?? 0,
        },
        messages: {
          unreadCount,
        },
        pages: {
          updatedToday: pagesUpdatedToday,
          updatedThisWeek: pagesUpdatedThisWeek,
        },
        calendar: {
          upcomingToday: upcomingTodayResult?.count ?? 0,
          pendingInvites: pendingInvitesResult?.count ?? 0,
        },
      },
      shouldRefresh,
    };

    return NextResponse.json(response);
  } catch (error) {
    loggers.api.error('Error fetching pulse:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch pulse' }, { status: 500 });
  }
}

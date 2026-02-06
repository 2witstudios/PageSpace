import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  db,
  pulseSummaries,
  taskItems,
  directMessages,
  dmConversations,
  pages,
  driveMembers,
  eq,
  and,
  or,
  lt,
  gte,
  ne,
  desc,
  count,
  inArray,
} from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

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
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

    // Week boundaries (Sunday start)
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - dayOfWeek);
    const endOfWeek = new Date(startOfWeek.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Fetch latest pulse summary
    const [latestSummary] = await db
      .select()
      .from(pulseSummaries)
      .where(eq(pulseSummaries.userId, userId))
      .orderBy(desc(pulseSummaries.generatedAt))
      .limit(1);

    // Calculate real-time stats
    // Get user's drives
    const userDrives = await db
      .select({ driveId: driveMembers.driveId })
      .from(driveMembers)
      .where(eq(driveMembers.userId, userId));
    const driveIds = userDrives.map(d => d.driveId);

    // Task counts
    const [tasksOverdue] = await db
      .select({ count: count() })
      .from(taskItems)
      .where(
        and(
          or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
          ne(taskItems.status, 'completed'),
          lt(taskItems.dueDate, startOfToday)
        )
      );

    const [tasksDueToday] = await db
      .select({ count: count() })
      .from(taskItems)
      .where(
        and(
          or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
          ne(taskItems.status, 'completed'),
          gte(taskItems.dueDate, startOfToday),
          lt(taskItems.dueDate, endOfToday)
        )
      );

    const [tasksDueThisWeek] = await db
      .select({ count: count() })
      .from(taskItems)
      .where(
        and(
          or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
          ne(taskItems.status, 'completed'),
          gte(taskItems.dueDate, startOfToday),
          lt(taskItems.dueDate, endOfWeek)
        )
      );

    const [tasksCompletedThisWeek] = await db
      .select({ count: count() })
      .from(taskItems)
      .where(
        and(
          or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
          eq(taskItems.status, 'completed'),
          gte(taskItems.completedAt, startOfWeek)
        )
      );

    // Unread messages
    const userConversations = await db
      .select({ id: dmConversations.id })
      .from(dmConversations)
      .where(
        or(
          eq(dmConversations.participant1Id, userId),
          eq(dmConversations.participant2Id, userId)
        )
      );

    let unreadCount = 0;
    if (userConversations.length > 0) {
      const conversationIds = userConversations.map(c => c.id);
      const [unreadResult] = await db
        .select({ count: count() })
        .from(directMessages)
        .where(
          and(
            inArray(directMessages.conversationId, conversationIds),
            ne(directMessages.senderId, userId),
            eq(directMessages.isRead, false)
          )
        );
      unreadCount = unreadResult?.count ?? 0;
    }

    // Pages updated
    let pagesUpdatedToday = 0;
    let pagesUpdatedThisWeek = 0;

    if (driveIds.length > 0) {
      const [todayResult] = await db
        .select({ count: count() })
        .from(pages)
        .where(
          and(
            inArray(pages.driveId, driveIds),
            eq(pages.isTrashed, false),
            gte(pages.updatedAt, startOfToday)
          )
        );
      pagesUpdatedToday = todayResult?.count ?? 0;

      const [weekResult] = await db
        .select({ count: count() })
        .from(pages)
        .where(
          and(
            inArray(pages.driveId, driveIds),
            eq(pages.isTrashed, false),
            gte(pages.updatedAt, startOfWeek)
          )
        );
      pagesUpdatedThisWeek = weekResult?.count ?? 0;
    }

    // Determine if summary is stale
    const isStale = latestSummary
      ? new Date(latestSummary.generatedAt).getTime() < sixHoursAgo.getTime()
      : true;

    // Determine if client should refresh
    const shouldRefresh = !latestSummary || isStale;

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
      },
      shouldRefresh,
    };

    return NextResponse.json(response);
  } catch (error) {
    loggers.api.error('Error fetching pulse:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch pulse' }, { status: 500 });
  }
}

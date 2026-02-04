import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import {
  db,
  taskItems,
  directMessages,
  dmConversations,
  pages,
  drives,
  driveMembers,
  eq,
  and,
  or,
  lt,
  gte,
  ne,
  sql,
  count,
} from '@pagespace/db';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session'] as const };

export type ActivitySummary = {
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

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

    // Calculate start of week (Sunday)
    const dayOfWeek = now.getDay();
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfWeek.getDate() - dayOfWeek);

    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 7);

    // Get task counts for this user
    // Tasks assigned to user or created by user
    const [tasksDueTodayResult] = await db
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

    const [tasksDueThisWeekResult] = await db
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

    const [tasksOverdueResult] = await db
      .select({ count: count() })
      .from(taskItems)
      .where(
        and(
          or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
          ne(taskItems.status, 'completed'),
          lt(taskItems.dueDate, startOfToday)
        )
      );

    const [tasksCompletedThisWeekResult] = await db
      .select({ count: count() })
      .from(taskItems)
      .where(
        and(
          or(eq(taskItems.assigneeId, userId), eq(taskItems.userId, userId)),
          eq(taskItems.status, 'completed'),
          gte(taskItems.completedAt, startOfWeek)
        )
      );

    // Get unread DM count
    // Find conversations where user is a participant
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
            sql`${directMessages.conversationId} IN (${sql.join(conversationIds.map(id => sql`${id}`), sql`, `)})`,
            ne(directMessages.senderId, userId),
            eq(directMessages.isRead, false)
          )
        );
      unreadCount = unreadResult?.count ?? 0;
    }

    // Get pages updated count (pages in drives user has access to)
    // First get drives user has access to (both owned and member drives)
    const [ownedDrives, memberDrives] = await Promise.all([
      db.select({ driveId: drives.id }).from(drives).where(eq(drives.ownerId, userId)),
      db.select({ driveId: driveMembers.driveId }).from(driveMembers).where(eq(driveMembers.userId, userId)),
    ]);

    // Combine and deduplicate drive IDs
    const driveIdSet = new Set([
      ...ownedDrives.map(d => d.driveId),
      ...memberDrives.map(d => d.driveId),
    ]);
    const userDrives = Array.from(driveIdSet).map(driveId => ({ driveId }));

    let pagesUpdatedToday = 0;
    let pagesUpdatedThisWeek = 0;

    if (userDrives.length > 0) {
      const driveIds = userDrives.map(d => d.driveId);

      const [pagesUpdatedTodayResult] = await db
        .select({ count: count() })
        .from(pages)
        .where(
          and(
            sql`${pages.driveId} IN (${sql.join(driveIds.map(id => sql`${id}`), sql`, `)})`,
            eq(pages.isTrashed, false),
            gte(pages.updatedAt, startOfToday)
          )
        );

      const [pagesUpdatedThisWeekResult] = await db
        .select({ count: count() })
        .from(pages)
        .where(
          and(
            sql`${pages.driveId} IN (${sql.join(driveIds.map(id => sql`${id}`), sql`, `)})`,
            eq(pages.isTrashed, false),
            gte(pages.updatedAt, startOfWeek)
          )
        );

      pagesUpdatedToday = pagesUpdatedTodayResult?.count ?? 0;
      pagesUpdatedThisWeek = pagesUpdatedThisWeekResult?.count ?? 0;
    }

    const summary: ActivitySummary = {
      tasks: {
        dueToday: tasksDueTodayResult?.count ?? 0,
        dueThisWeek: tasksDueThisWeekResult?.count ?? 0,
        overdue: tasksOverdueResult?.count ?? 0,
        completedThisWeek: tasksCompletedThisWeekResult?.count ?? 0,
      },
      messages: {
        unreadCount,
      },
      pages: {
        updatedToday: pagesUpdatedToday,
        updatedThisWeek: pagesUpdatedThisWeek,
      },
    };

    return NextResponse.json(summary);
  } catch (error) {
    loggers.api.error('Error fetching activity summary:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch activity summary' }, { status: 500 });
  }
}

import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq, ne, and, or, count, isNull } from '@pagespace/db/operators';
import { directMessages, dmConversations } from '@pagespace/db/schema/social';
import { notifications } from '@pagespace/db/schema/notifications';
import { pages } from '@pagespace/db/schema/core';
import { calendarEvents, eventAttendees } from '@pagespace/db/schema/calendar';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const { userId } = auth;

  try {
    const [dmResult, channelMentionResult, fileMentionResult, taskResult, calendarResult] =
      await Promise.all([
        // Unread DMs from other participants (top-level messages only)
        db
          .select({ count: count() })
          .from(directMessages)
          .innerJoin(dmConversations, eq(directMessages.conversationId, dmConversations.id))
          .where(
            and(
              or(
                eq(dmConversations.participant1Id, userId),
                eq(dmConversations.participant2Id, userId)
              ),
              ne(directMessages.senderId, userId),
              eq(directMessages.isRead, false),
              eq(directMessages.isActive, true),
              isNull(directMessages.parentId)
            )
          ),

        // Unread @mention notifications in channel pages
        db
          .select({ count: count() })
          .from(notifications)
          .innerJoin(pages, eq(notifications.pageId, pages.id))
          .where(
            and(
              eq(notifications.userId, userId),
              eq(notifications.isRead, false),
              eq(notifications.type, 'MENTION'),
              eq(pages.type, 'CHANNEL')
            )
          ),

        // Unread @mention notifications in non-channel pages (docs, files, etc.)
        db
          .select({ count: count() })
          .from(notifications)
          .innerJoin(pages, eq(notifications.pageId, pages.id))
          .where(
            and(
              eq(notifications.userId, userId),
              eq(notifications.isRead, false),
              eq(notifications.type, 'MENTION'),
              ne(pages.type, 'CHANNEL')
            )
          ),

        // Unread task assignment notifications
        db
          .select({ count: count() })
          .from(notifications)
          .where(
            and(
              eq(notifications.userId, userId),
              eq(notifications.isRead, false),
              eq(notifications.type, 'TASK_ASSIGNED')
            )
          ),

        // Pending calendar invites where user is not the organizer
        db
          .select({ count: count() })
          .from(eventAttendees)
          .innerJoin(calendarEvents, eq(eventAttendees.eventId, calendarEvents.id))
          .where(
            and(
              eq(eventAttendees.userId, userId),
              eq(eventAttendees.status, 'PENDING'),
              eq(eventAttendees.isOrganizer, false),
              eq(calendarEvents.isTrashed, false)
            )
          ),
      ]);

    return NextResponse.json({
      dms: Number(dmResult[0]?.count ?? 0),
      channels: Number(channelMentionResult[0]?.count ?? 0),
      files: Number(fileMentionResult[0]?.count ?? 0),
      tasks: Number(taskResult[0]?.count ?? 0),
      calendar: Number(calendarResult[0]?.count ?? 0),
    });
  } catch (error) {
    loggers.api.error('Error fetching sidebar badges:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch sidebar badges' }, { status: 500 });
  }
}

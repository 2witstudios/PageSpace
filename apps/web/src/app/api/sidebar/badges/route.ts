import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq, ne, and, or, count, isNull, gte, sql } from '@pagespace/db/operators';
import { directMessages, dmConversations } from '@pagespace/db/schema/social';
import { notifications } from '@pagespace/db/schema/notifications';
import { pages } from '@pagespace/db/schema/core';
import { calendarEvents, eventAttendees } from '@pagespace/db/schema/calendar';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { getBatchPagePermissions } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

type ChannelUnreadRow = { id: string; unread_count: string };

/**
 * Total unread channel messages across every drive the user owns or belongs to.
 *
 * The CTEs mirror /api/inbox's user-wide channel query (`user_channels` and
 * `channel_unread`) so this nav number equals the sum of the per-channel pills
 * that surface on the /channels route. Keep the two in step when either moves.
 *
 * A `mute` filter, when one exists, belongs as another join/predicate on
 * `user_channels` — nothing else here needs to change for it.
 */
async function countChannelUnread(userId: string): Promise<number> {
  const result = await db.execute<ChannelUnreadRow>(sql`
    WITH user_channels AS (
      SELECT p.id
      FROM pages p
      INNER JOIN drives d ON d.id = p."driveId"
      LEFT JOIN drive_members dm ON dm."driveId" = d.id AND dm."userId" = ${userId}
      WHERE p.type = 'CHANNEL'
        AND p."isTrashed" = false
        AND (d."ownerId" = ${userId} OR dm."userId" IS NOT NULL)
    ),
    channel_unread AS (
      SELECT cm."pageId", COUNT(*) as unread_count
      FROM channel_messages cm
      LEFT JOIN channel_read_status crs
        ON crs."channelId" = cm."pageId" AND crs."userId" = ${userId}
      WHERE cm."createdAt" > COALESCE(crs."lastReadAt", '1970-01-01'::timestamp)
        AND (
          cm."userId" != ${userId}
          OR cm."aiMeta"->>'senderType' = 'agent'
        )
      GROUP BY cm."pageId"
    )
    SELECT uc.id, cu.unread_count
    FROM user_channels uc
    INNER JOIN channel_unread cu ON cu."pageId" = uc.id
    WHERE cu.unread_count > 0
  `);

  const rows = result.rows;
  if (rows.length === 0) return 0;

  // Drive membership is not page access: a channel can be permissioned away
  // from a member. Filter through the centralized helper, never hand-rolled SQL.
  const permissions = await getBatchPagePermissions(
    userId,
    rows.map((row) => row.id)
  );

  return rows.reduce(
    (sum, row) =>
      permissions.get(row.id)?.canView ? sum + (Number(row.unread_count) || 0) : sum,
    0
  );
}

export async function GET(req: Request) {
  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const { userId } = auth;

  try {
    const [dmResult, channelUnreadCount, fileMentionResult, taskResult, calendarResult] =
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

        // Unread channel messages (watermark-based, not @mention-only): any
        // message past the user's channel_read_status watermark counts, which
        // subsumes mentions since an @mention is also an unread message.
        countChannelUnread(userId),

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

        // Pending RSVP invites for upcoming events where user is not the organizer
        db
          .select({ count: count() })
          .from(eventAttendees)
          .innerJoin(calendarEvents, eq(eventAttendees.eventId, calendarEvents.id))
          .where(
            and(
              eq(eventAttendees.userId, userId),
              eq(eventAttendees.status, 'PENDING'),
              eq(eventAttendees.isOrganizer, false),
              eq(calendarEvents.isTrashed, false),
              gte(calendarEvents.startAt, new Date())
            )
          ),
      ]);

    auditRequest(req, { eventType: 'data.read', userId, resourceType: 'badge', resourceId: 'self' });

    return NextResponse.json({
      dms: Number(dmResult[0]?.count ?? 0),
      channels: channelUnreadCount,
      files: Number(fileMentionResult[0]?.count ?? 0),
      tasks: Number(taskResult[0]?.count ?? 0),
      calendar: Number(calendarResult[0]?.count ?? 0),
    });
  } catch (error) {
    loggers.api.error('Error fetching sidebar badges:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch sidebar badges' }, { status: 500 });
  }
}

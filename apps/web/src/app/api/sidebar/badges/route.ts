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
 * Bound on channels-with-unread carried back from one badge request. The badge
 * renders "99+" past two digits, so no reachable number of channels changes what
 * the user sees — this only stops an unbounded id list reaching the `inArray` in
 * getBatchPagePermissions (the hazard apps/web/eslint.config.mjs guards for
 * `findMany`, which cannot see a raw `db.execute`).
 */
const MAX_UNREAD_CHANNELS = 500;

/**
 * Total unread channel messages across every drive the user owns or belongs to.
 *
 * Counts the same thing as /api/inbox's per-channel `unreadCount` — same
 * watermark, same self-vs-agent rule — so this nav number and the per-channel
 * pills on the /channels route agree. Keep the two in step when either moves.
 *
 * It does NOT spell it the same way. /api/inbox aggregates `channel_messages`
 * whole and restricts afterwards, which the planner cannot push down: the
 * restriction is a join qual, and join quals are not pushed beneath a GROUP BY.
 * Measured on 400k messages across 500 channels with the user in 10 of them,
 * that plan seq-scans every row and aggregates every channel — 2952 buffers,
 * 52ms — to return 10 rows. Adding an INNER JOIN inside the aggregate does not
 * help; the planner still drives from `channel_messages` (85ms). The LATERAL
 * below forces the nested loop, so each of the user's channels is an index
 * lookup: 105 buffers, 1.3ms, and it scales with the user's channel count
 * rather than the size of the table. That matters here and not on /api/inbox
 * because this endpoint is hit on every page load, and one message in an
 * N-member drive schedules N of these.
 *
 * A `mute` filter, when one exists, belongs as another predicate on
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
    )
    SELECT uc.id, x.unread_count
    FROM user_channels uc
    CROSS JOIN LATERAL (
      SELECT COUNT(*) as unread_count
      FROM channel_messages cm
      WHERE cm."pageId" = uc.id
        AND cm."isActive" = true
        AND cm."createdAt" > COALESCE(
          (
            SELECT crs."lastReadAt"
            FROM channel_read_status crs
            WHERE crs."channelId" = uc.id AND crs."userId" = ${userId}
          ),
          '1970-01-01'::timestamp
        )
        AND (
          cm."userId" != ${userId}
          OR cm."aiMeta"->>'senderType' = 'agent'
        )
    ) x
    WHERE x.unread_count > 0
    LIMIT ${MAX_UNREAD_CHANNELS}
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
        //
        // Degraded rather than fatal. This slot went from an indexed two-table
        // count() to raw SQL plus a permission batch, and it sits in a
        // Promise.all whose rejection 500s the route — which the client renders
        // as all five badges blank, not one. Reporting no unread channels when
        // the query fails loses less than blanking the other four, and matches
        // getBatchPagePermissions, which already swallows its own failures into
        // an all-deny map (i.e. zero) rather than throwing.
        countChannelUnread(userId).catch((error) => {
          loggers.api.error('Failed to count unread channel messages:', error as Error);
          return 0;
        }),

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

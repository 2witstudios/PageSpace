import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { sql, eq } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { broadcastInboxEvent } from '@/lib/websocket/socket-utils';
import { markPageNotificationsRead } from '@pagespace/lib/notifications/notifications';

const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

// POST /api/channels/[pageId]/read - Mark channel as read
export async function POST(
  request: Request,
  context: { params: Promise<{ pageId: string }> }
) {
  const { pageId } = await context.params;

  const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  // Verify channel exists and user has access
  const channel = await db.query.pages.findFirst({
    where: eq(pages.id, pageId),
    columns: { id: true, type: true, driveId: true },
  });

  if (!channel || channel.type !== 'CHANNEL') {
    return NextResponse.json({ error: 'Channel not found' }, { status: 404 });
  }

  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  // Upsert the read status
  await db.execute(sql`
    INSERT INTO channel_read_status ("userId", "channelId", "lastReadAt")
    VALUES (${userId}, ${pageId}, NOW())
    ON CONFLICT ("userId", "channelId")
    DO UPDATE SET "lastReadAt" = NOW()
  `);

  // Broadcast read status change and clear MENTION (and other) notifications
  // tied to this page in parallel — independent writes, no dependency between
  // them. Skipping the notification clear would leave the nav Channels badge
  // lit even though the channel itself is read.
  const [, notificationsMarkedRead] = await Promise.all([
    broadcastInboxEvent(userId, {
      operation: 'read_status_changed',
      type: 'channel',
      id: pageId,
      driveId: channel.driveId,
      unreadCount: 0,
    }),
    markPageNotificationsRead(userId, pageId),
  ]);

  loggers.api.debug('Channel marked as read', { channelId: pageId, userId, notificationsMarkedRead });

  return NextResponse.json({ success: true, notificationsMarkedRead });
}

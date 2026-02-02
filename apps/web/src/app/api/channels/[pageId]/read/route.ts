import { NextResponse } from 'next/server';
import { db, sql, pages, eq } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { broadcastInboxEvent } from '@/lib/websocket/socket-utils';

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

  // Broadcast read status change to user's inbox
  await broadcastInboxEvent(userId, {
    operation: 'read_status_changed',
    type: 'channel',
    id: pageId,
    driveId: channel.driveId,
    unreadCount: 0,
  });

  loggers.api.debug('Channel marked as read', { channelId: pageId, userId });

  return NextResponse.json({ success: true });
}

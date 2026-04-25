import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { channelMessages } from '@pagespace/db/schema/chat';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/permissions/permissions';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

type RouteParams = { params: Promise<{ pageId: string; messageId: string }> };

/**
 * PATCH /api/channels/[pageId]/messages/[messageId]
 * Edit a channel message (own messages only)
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const { pageId, messageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const message = await db.query.channelMessages.findFirst({
    where: and(eq(channelMessages.id, messageId), eq(channelMessages.pageId, pageId)),
  });

  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  if (message.userId !== userId) {
    return NextResponse.json({ error: 'You can only edit your own messages' }, { status: 403 });
  }

  if (message.aiMeta) {
    return NextResponse.json({ error: 'AI messages cannot be edited' }, { status: 403 });
  }

  const { content } = await req.json() as { content: string };
  if (!content || typeof content !== 'string' || !content.trim()) {
    return NextResponse.json({ error: 'Content is required' }, { status: 400 });
  }

  const editedAt = new Date();
  await db.update(channelMessages)
    .set({ content: content.trim(), editedAt })
    .where(eq(channelMessages.id, messageId));

  auditRequest(req, {
    eventType: 'data.update',
    userId,
    resourceType: 'channel_message',
    resourceId: messageId,
    details: { pageId },
  });

  if (process.env.INTERNAL_REALTIME_URL) {
    try {
      const requestBody = JSON.stringify({
        channelId: pageId,
        event: 'message_edited',
        payload: { messageId, content: content.trim(), editedAt: editedAt.toISOString() },
      });
      await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
        method: 'POST',
        headers: createSignedBroadcastHeaders(requestBody),
        body: requestBody,
      });
    } catch (error) {
      loggers.realtime.error('Failed to broadcast message_edited:', error as Error);
    }
  }

  return NextResponse.json({ id: messageId, content: content.trim(), editedAt: editedAt.toISOString() });
}

/**
 * DELETE /api/channels/[pageId]/messages/[messageId]
 * Soft-delete a channel message (own messages only)
 */
export async function DELETE(req: Request, { params }: RouteParams) {
  const { pageId, messageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const message = await db.query.channelMessages.findFirst({
    where: and(eq(channelMessages.id, messageId), eq(channelMessages.pageId, pageId)),
  });

  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  if (message.userId !== userId) {
    return NextResponse.json({ error: 'You can only delete your own messages' }, { status: 403 });
  }

  await db.update(channelMessages)
    .set({ isActive: false })
    .where(eq(channelMessages.id, messageId));

  auditRequest(req, {
    eventType: 'data.delete',
    userId,
    resourceType: 'channel_message',
    resourceId: messageId,
    details: { pageId },
  });

  if (process.env.INTERNAL_REALTIME_URL) {
    try {
      const requestBody = JSON.stringify({
        channelId: pageId,
        event: 'message_deleted',
        payload: { messageId },
      });
      await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
        method: 'POST',
        headers: createSignedBroadcastHeaders(requestBody),
        body: requestBody,
      });
    } catch (error) {
      loggers.realtime.error('Failed to broadcast message_deleted:', error as Error);
    }
  }

  return new NextResponse(null, { status: 204 });
}

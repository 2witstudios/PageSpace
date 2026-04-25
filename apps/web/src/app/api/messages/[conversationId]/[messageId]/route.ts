import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db';
import { eq, and, or } from '@pagespace/db/operators';
import { directMessages, dmConversations } from '@pagespace/db/schema/social';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

type RouteParams = { params: Promise<{ conversationId: string; messageId: string }> };

async function verifyParticipant(userId: string, conversationId: string) {
  const [conv] = await db
    .select()
    .from(dmConversations)
    .where(
      and(
        eq(dmConversations.id, conversationId),
        or(
          eq(dmConversations.participant1Id, userId),
          eq(dmConversations.participant2Id, userId)
        )
      )
    )
    .limit(1);
  return conv;
}

/**
 * PATCH /api/messages/[conversationId]/[messageId]
 * Edit a DM (sender only)
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const { conversationId, messageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const conv = await verifyParticipant(userId, conversationId);
  if (!conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const message = await db.query.directMessages.findFirst({
    where: and(
      eq(directMessages.id, messageId),
      eq(directMessages.conversationId, conversationId)
    ),
  });

  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  if (message.senderId !== userId) {
    return NextResponse.json({ error: 'You can only edit your own messages' }, { status: 403 });
  }

  const { content } = await req.json() as { content: string };
  if (!content || typeof content !== 'string' || !content.trim()) {
    return NextResponse.json({ error: 'Content is required' }, { status: 400 });
  }

  const editedAt = new Date();
  await db.update(directMessages)
    .set({ content: content.trim(), isEdited: true, editedAt })
    .where(eq(directMessages.id, messageId));

  auditRequest(req, {
    eventType: 'data.update',
    userId,
    resourceType: 'direct_message',
    resourceId: messageId,
    details: { conversationId },
  });

  return NextResponse.json({
    id: messageId,
    content: content.trim(),
    isEdited: true,
    editedAt: editedAt.toISOString(),
  });
}

/**
 * DELETE /api/messages/[conversationId]/[messageId]
 * Hard-delete a DM (sender only)
 */
export async function DELETE(req: Request, { params }: RouteParams) {
  const { conversationId, messageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const conv = await verifyParticipant(userId, conversationId);
  if (!conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const message = await db.query.directMessages.findFirst({
    where: and(
      eq(directMessages.id, messageId),
      eq(directMessages.conversationId, conversationId)
    ),
  });

  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  if (message.senderId !== userId) {
    return NextResponse.json({ error: 'You can only delete your own messages' }, { status: 403 });
  }

  await db.delete(directMessages).where(eq(directMessages.id, messageId));

  auditRequest(req, {
    eventType: 'data.delete',
    userId,
    resourceType: 'direct_message',
    resourceId: messageId,
    details: { conversationId },
  });

  return new NextResponse(null, { status: 204 });
}

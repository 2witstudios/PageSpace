import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { dmMessageRepository } from '@pagespace/lib/services/dm-message-repository';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

type RouteParams = { params: Promise<{ conversationId: string; messageId: string }> };

/**
 * PATCH /api/messages/[conversationId]/[messageId]
 * Edit a DM (sender only). Soft-deleted messages return 404 — the row is
 * invisible to edits, mirroring "message not found".
 */
export async function PATCH(req: Request, { params }: RouteParams) {
  const { conversationId, messageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const conv = await dmMessageRepository.findConversationForParticipant(
    conversationId,
    userId
  );
  if (!conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const message = await dmMessageRepository.findActiveMessage({
    messageId,
    conversationId,
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
  const edited = await dmMessageRepository.editActiveMessage({
    messageId,
    content: content.trim(),
    editedAt,
  });

  // A concurrent soft-delete between the lookup above and this update would
  // leave us with 0 affected rows. Surface the same "Message not found" the
  // caller would see if the soft-delete had landed first.
  if (edited === 0) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  auditRequest(req, {
    eventType: 'data.write',
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
 * Soft-delete a DM (sender only). Sets isActive=false so attached files are
 * not cascade-ripped from inbox previews and other live messages. A second
 * DELETE on the same message returns 404.
 */
export async function DELETE(req: Request, { params }: RouteParams) {
  const { conversationId, messageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  const conv = await dmMessageRepository.findConversationForParticipant(
    conversationId,
    userId
  );
  if (!conv) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }

  const message = await dmMessageRepository.findActiveMessage({
    messageId,
    conversationId,
  });

  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  if (message.senderId !== userId) {
    return NextResponse.json({ error: 'You can only delete your own messages' }, { status: 403 });
  }

  const deleted = await dmMessageRepository.softDeleteMessage(messageId);

  // Concurrent soft-delete between lookup and this update returns 0 affected
  // rows. Surface the same 404 the second-DELETE caller would see.
  if (deleted === 0) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  auditRequest(req, {
    eventType: 'data.delete',
    userId,
    resourceType: 'direct_message',
    resourceId: messageId,
    details: { conversationId, soft: true },
  });

  return NextResponse.json({ success: true });
}

import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { createOrUpdateMessageNotification } from '@pagespace/lib/notifications/notifications'
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { dmMessageRepository } from '@pagespace/lib/services/dm-message-repository';
import { broadcastInboxEvent } from '@/lib/websocket/socket-utils';
import { parseBoundedIntParam } from '@/lib/utils/query-params';
import type { AttachmentMeta } from '@pagespace/lib/types';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

// GET /api/messages/[conversationId] - Get messages in a conversation
export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { conversationId } = await context.params;
    const { searchParams } = new URL(request.url);
    const limit = parseBoundedIntParam(searchParams.get('limit'), {
      defaultValue: 50,
      min: 1,
      max: 100,
    });
    const beforeParam = searchParams.get('before');
    let before: Date | undefined;
    if (beforeParam) {
      before = new Date(beforeParam);
      if (Number.isNaN(before.getTime())) {
        return NextResponse.json(
          { error: 'Invalid before cursor' },
          { status: 400 }
        );
      }
    }

    const conversation = await dmMessageRepository.findConversationForParticipant(
      conversationId,
      userId
    );

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const messages = await dmMessageRepository.listActiveMessages({
      conversationId,
      limit,
      before,
    });

    const otherUserId = conversation.participant1Id === userId
      ? conversation.participant2Id
      : conversation.participant1Id;

    const readAt = new Date();
    await dmMessageRepository.markActiveMessagesRead({
      conversationId,
      otherUserId,
      readAt,
    });

    await dmMessageRepository.updateConversationLastRead({
      conversationId,
      participantSide: conversation.participant1Id === userId ? 'participant1' : 'participant2',
      readAt,
    });

    // Show oldest first in the response payload.
    messages.reverse();

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'message', resourceId: conversationId });

    return NextResponse.json({ messages });
  } catch (error) {
    loggers.api.error('Error fetching messages:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch messages' },
      { status: 500 }
    );
  }
}

function isValidAttachmentMeta(value: unknown): value is AttachmentMeta {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m.originalName === 'string' &&
    typeof m.size === 'number' &&
    typeof m.mimeType === 'string' &&
    typeof m.contentHash === 'string'
  );
}

function buildLastMessagePreview(
  content: string,
  attachmentMeta: AttachmentMeta | null
): string {
  const trimmed = content.trim();
  if (trimmed.length > 0) {
    return trimmed.length > 100 ? trimmed.substring(0, 100) + '...' : trimmed;
  }
  if (attachmentMeta) {
    const isImage = attachmentMeta.mimeType.startsWith('image/');
    return isImage
      ? `[image: ${attachmentMeta.originalName}]`
      : `[file: ${attachmentMeta.originalName}]`;
  }
  return '';
}

// POST /api/messages/[conversationId] - Send a message
export async function POST(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const emailVerified = await isEmailVerified(userId);
    if (!emailVerified) {
      return NextResponse.json(
        {
          error: 'Email verification required. Please verify your email to perform this action.',
          requiresEmailVerification: true
        },
        { status: 403 }
      );
    }

    const { conversationId } = await context.params;
    const body = await request.json() as {
      content?: unknown;
      fileId?: unknown;
      attachmentMeta?: unknown;
    };

    const rawContent = typeof body.content === 'string' ? body.content : '';
    const content = rawContent.trim().length > 0 ? rawContent : '';
    const fileId = typeof body.fileId === 'string' && body.fileId.length > 0 ? body.fileId : null;
    const rawAttachmentMeta = body.attachmentMeta ?? null;

    if (content.length === 0 && !fileId) {
      return NextResponse.json(
        { error: 'Message content or file is required' },
        { status: 400 }
      );
    }

    if (fileId && rawAttachmentMeta === null) {
      return NextResponse.json(
        { error: 'attachmentMeta required when fileId is provided' },
        { status: 400 }
      );
    }

    let attachmentMeta: AttachmentMeta | null = null;
    if (fileId) {
      if (!isValidAttachmentMeta(rawAttachmentMeta)) {
        return NextResponse.json(
          { error: 'Invalid attachmentMeta shape' },
          { status: 400 }
        );
      }
      attachmentMeta = rawAttachmentMeta;
    }

    const conversation = await dmMessageRepository.findConversationForParticipant(
      conversationId,
      userId
    );

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    if (fileId) {
      const validation = await dmMessageRepository.validateAttachmentForDm({
        fileId,
        conversationId,
        senderId: userId,
      });

      if (validation.kind === 'not_found') {
        return NextResponse.json({ error: 'File not found' }, { status: 404 });
      }
      if (validation.kind === 'wrong_owner') {
        auditRequest(request, {
          eventType: 'authz.access.denied',
          userId,
          resourceType: 'dm_message',
          resourceId: fileId,
          details: { reason: 'file_owner_mismatch', conversationId },
        });
        return NextResponse.json(
          { error: 'You do not own this file' },
          { status: 403 }
        );
      }
      if (validation.kind === 'not_linked') {
        auditRequest(request, {
          eventType: 'authz.access.denied',
          userId,
          resourceType: 'dm_message',
          resourceId: fileId,
          details: { reason: 'file_not_linked_to_conversation', conversationId },
        });
        return NextResponse.json(
          { error: 'File is not linked to this conversation' },
          { status: 403 }
        );
      }
    }

    const newMessage = await dmMessageRepository.insertDmMessage({
      conversationId,
      senderId: userId,
      content,
      fileId,
      attachmentMeta,
    });

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'message',
      resourceId: newMessage.id,
    });

    const messagePreview = buildLastMessagePreview(content, attachmentMeta);

    await dmMessageRepository.updateConversationLastMessage({
      conversationId,
      lastMessageAt: newMessage.createdAt,
      lastMessagePreview: messagePreview,
    });

    const recipientId = conversation.participant1Id === userId
      ? conversation.participant2Id
      : conversation.participant1Id;

    await createOrUpdateMessageNotification(
      recipientId,
      conversationId,
      messagePreview,
      userId
    );

    if (process.env.INTERNAL_REALTIME_URL) {
      try {
        const requestBody = JSON.stringify({
          channelId: `dm:${conversationId}`,
          event: 'new_dm_message',
          payload: newMessage,
        });

        await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
          method: 'POST',
          headers: createSignedBroadcastHeaders(requestBody),
          body: requestBody,
        });
      } catch (error) {
        loggers.realtime?.error?.('Failed to broadcast DM message to socket server:', error as Error);
      }
    }

    await broadcastInboxEvent(recipientId, {
      operation: 'dm_updated',
      type: 'dm',
      id: conversationId,
      lastMessageAt: newMessage.createdAt.toISOString(),
      lastMessagePreview: messagePreview,
      attachmentMeta,
    });

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'conversation',
      resourceId: conversationId,
    });

    return NextResponse.json({ message: newMessage });
  } catch (error) {
    loggers.api.error('Error sending message:', error as Error);
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    );
  }
}

// PATCH /api/messages/[conversationId] - Mark messages as read
export async function PATCH(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_WRITE);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { conversationId } = await context.params;

    const conversation = await dmMessageRepository.findConversationForParticipant(
      conversationId,
      userId
    );

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const otherUserId = conversation.participant1Id === userId
      ? conversation.participant2Id
      : conversation.participant1Id;

    const readAt = new Date();
    await dmMessageRepository.markActiveMessagesRead({
      conversationId,
      otherUserId,
      readAt,
    });

    await dmMessageRepository.updateConversationLastRead({
      conversationId,
      participantSide: conversation.participant1Id === userId ? 'participant1' : 'participant2',
      readAt,
    });

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'message', resourceId: conversationId, details: { operation: 'mark_read' } });

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error marking messages as read:', error as Error);
    return NextResponse.json(
      { error: 'Failed to mark messages as read' },
      { status: 500 }
    );
  }
}

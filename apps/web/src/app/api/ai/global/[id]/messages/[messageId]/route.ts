import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { maskIdentifier } from '@/lib/logging/mask';
import { globalConversationRepository } from '@/lib/repositories/global-conversation-repository';
import { processMessageContentUpdate } from '@/lib/repositories/chat-message-repository';
import { getActorInfo, logMessageActivity } from '@pagespace/lib/monitoring/activity-logger';
import { broadcastAiMessageEdited, broadcastAiMessageDeleted } from '@/lib/websocket/socket-utils';
import { resolveTriggeredBy } from '@/lib/websocket/broadcast-triggered-by';
import { globalChannelId } from '@pagespace/lib/ai/global-channel-id';
import { getState, invalidate } from '@/lib/ai/core/compaction/compaction-repository';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

/**
 * PATCH - Edit message content
 * Updates a conversation message's content and sets editedAt timestamp
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> }
) {
  try {
    // Authenticate
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'global_chat_message', resourceId: 'edit', details: { reason: 'auth_failed', method: 'PATCH', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const { id: conversationId, messageId } = await context.params;
    const { content } = await request.json();

    // Validate content
    if (!content || typeof content !== 'string') {
      return NextResponse.json(
        { error: 'Content is required and must be a string' },
        { status: 400 }
      );
    }

    // Verify user owns the conversation
    const conversation = await globalConversationRepository.getConversationById(userId, conversationId);
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Get the message to verify it belongs to this conversation
    const message = await globalConversationRepository.getMessageById(conversationId, messageId);
    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    // A 'streaming' row is mid-flight: its content is a placeholder the generation is about
    // to overwrite via the execute-end/onFinish upsert. Editing it now would be silently
    // clobbered the moment that upsert lands. See Server Stream Durability epic PR 2.
    if (message.status === 'streaming') {
      return NextResponse.json(
        { error: 'This message is still generating and cannot be edited yet' },
        { status: 409 }
      );
    }

    // Store original content for activity logging
    const originalContent = message.content;

    // Process content update (preserving structure if needed)
    const updatedContent = processMessageContentUpdate(message.content, content);

    // Update the message content
    await globalConversationRepository.updateMessageContent(messageId, updatedContent);

    // Invalidate compaction when a message in this conversation is edited (stale summary guard).
    // Awaited so the stale summary cannot be read by a concurrent request before we return.
    try {
      const state = await getState(conversationId, { source: 'global' });
      // No row: a first compaction may be in flight — write the invalidation
      // tombstone so its pending insert loses. Row present: invalidate only
      // when the touched message is inside the compacted range (later edits
      // leave the still-valid summary in place).
      if (!state || (state.compactedUpToCreatedAt && message.createdAt <= state.compactedUpToCreatedAt)) {
        await invalidate(conversationId, { source: 'global' });
      }
    } catch (err) {
      loggers.api.error('Failed to invalidate compaction state after global message edit', err as Error);
    }

    // Broadcast to remote viewers (other tabs of this user). Failure must never break the request.
    void (async () => {
      try {
        const triggeredBy = await resolveTriggeredBy(userId, request);
        await broadcastAiMessageEdited({
          messageId,
          pageId: globalChannelId(userId),
          conversationId,
          parts: [{ type: 'text', text: updatedContent }],
          editedAt: new Date().toISOString(),
          triggeredBy,
        });
      } catch (broadcastError) {
        loggers.api.error('Failed to broadcast global message edit', broadcastError as Error, {
          messageId: maskIdentifier(messageId),
          conversationId: maskIdentifier(conversationId),
        });
      }
    })();

    // Log activity for audit trail (non-blocking)
    try {
      const actorInfo = await getActorInfo(userId);
      logMessageActivity(userId, 'message_update', {
        id: messageId,
        pageId: conversationId, // Global conversations use conversationId as identifier
        driveId: null, // Global conversations are user-level, not drive-level
        conversationType: 'global',
      }, actorInfo, {
        previousContent: originalContent,
        newContent: updatedContent,
        aiConversationId: conversationId,
      });
    } catch (loggingError) {
      loggers.api.error('Failed to log message update activity', loggingError as Error, {
        messageId: maskIdentifier(messageId),
        conversationId: maskIdentifier(conversationId)
      });
    }

    loggers.api.info('Global Assistant message edited successfully', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      conversationId: maskIdentifier(conversationId)
    });

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'global_chat_message', resourceId: messageId, details: {
      action: 'edit_message',
      conversationId,
    } });

    return NextResponse.json({
      success: true,
      message: 'Message updated successfully'
    });
  } catch (error) {
    loggers.api.error('Error editing Global Assistant message', error as Error);
    return NextResponse.json(
      { error: 'Failed to edit message' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Soft delete a message
 * Sets isActive to false to hide the message
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; messageId: string }> }
) {
  try {
    // Authenticate
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) {
      auditRequest(request, { eventType: 'authz.access.denied', resourceType: 'global_chat_message', resourceId: 'delete', details: { reason: 'auth_failed', method: 'DELETE', authFailureReason: auth.authFailureReason }, riskScore: 0.5 });
      return auth.error;
    }
    const userId = auth.userId;

    const { id: conversationId, messageId } = await context.params;

    // Verify user owns the conversation
    const conversation = await globalConversationRepository.getConversationById(userId, conversationId);
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Get the message to verify it belongs to this conversation
    const message = await globalConversationRepository.getMessageById(conversationId, messageId);
    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    // A 'streaming' row is mid-flight: deleting it now would race the execute-end/onFinish
    // upsert, which does not check isActive and would resurrect the row's content into an
    // inactive-but-visible-again state. See Server Stream Durability epic PR 2.
    if (message.status === 'streaming') {
      return NextResponse.json(
        { error: 'This message is still generating and cannot be deleted yet' },
        { status: 409 }
      );
    }

    // Store content for audit trail before deletion
    const deletedContent = message.content;

    // Soft delete the message
    await globalConversationRepository.softDeleteMessage(messageId);

    // Invalidate compaction when a message in this conversation is deleted (stale summary guard).
    // Awaited so the stale summary cannot be read by a concurrent request before we return.
    try {
      const state = await getState(conversationId, { source: 'global' });
      // No row: a first compaction may be in flight — write the invalidation
      // tombstone so its pending insert loses. Row present: invalidate only
      // when the touched message is inside the compacted range (later edits
      // leave the still-valid summary in place).
      if (!state || (state.compactedUpToCreatedAt && message.createdAt <= state.compactedUpToCreatedAt)) {
        await invalidate(conversationId, { source: 'global' });
      }
    } catch (err) {
      loggers.api.error('Failed to invalidate compaction state after global message delete', err as Error);
    }

    // Broadcast to remote viewers (other tabs of this user). Failure must never break the request.
    void (async () => {
      try {
        const triggeredBy = await resolveTriggeredBy(userId, request);
        await broadcastAiMessageDeleted({
          messageId,
          pageId: globalChannelId(userId),
          conversationId,
          triggeredBy,
        });
      } catch (broadcastError) {
        loggers.api.error('Failed to broadcast global message delete', broadcastError as Error, {
          messageId: maskIdentifier(messageId),
          conversationId: maskIdentifier(conversationId),
        });
      }
    })();

    // Log activity for audit trail (non-blocking)
    try {
      const actorInfo = await getActorInfo(userId);
      logMessageActivity(userId, 'message_delete', {
        id: messageId,
        pageId: conversationId, // Global conversations use conversationId as identifier
        driveId: null, // Global conversations are user-level, not drive-level
        conversationType: 'global',
      }, actorInfo, {
        previousContent: deletedContent,
        aiConversationId: conversationId,
      });
    } catch (loggingError) {
      loggers.api.error('Failed to log message deletion activity', loggingError as Error, {
        messageId: maskIdentifier(messageId),
        conversationId: maskIdentifier(conversationId)
      });
    }

    loggers.api.info('Global Assistant message deleted successfully', {
      userId: maskIdentifier(userId),
      messageId: maskIdentifier(messageId),
      conversationId: maskIdentifier(conversationId)
    });

    auditRequest(request, { eventType: 'data.delete', userId, resourceType: 'global_chat_message', resourceId: messageId, details: {
      action: 'delete_message',
      conversationId,
    } });

    return NextResponse.json({
      success: true,
      message: 'Message deleted successfully'
    });
  } catch (error) {
    loggers.api.error('Error deleting Global Assistant message', error as Error);
    return NextResponse.json(
      { error: 'Failed to delete message' },
      { status: 500 }
    );
  }
}

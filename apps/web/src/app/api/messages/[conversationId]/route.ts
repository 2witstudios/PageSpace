import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { createOrUpdateMessageNotification } from '@pagespace/lib/notifications/notifications'
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { dmMessageRepository } from '@pagespace/lib/services/dm-message-repository';
import { broadcastInboxEvent, broadcastThreadReplyCountUpdated } from '@/lib/websocket/socket-utils';
import { parseBoundedIntParam } from '@/lib/utils/query-params';
import { extractMentionedUserIds } from '@/lib/channels/extract-user-mentions';
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
    const cursorParam = searchParams.get('cursor');
    const rawParentId = searchParams.get('parentId');
    const parentId = rawParentId ? rawParentId.trim() : '';
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

    let parsedAfter: { createdAt: Date; id: string } | undefined;
    if (cursorParam) {
      const sep = cursorParam.lastIndexOf('|');
      if (sep === -1) {
        return NextResponse.json({ error: 'Invalid cursor format' }, { status: 400 });
      }
      const cursorDate = new Date(cursorParam.slice(0, sep));
      const cursorId = cursorParam.slice(sep + 1);
      if (Number.isNaN(cursorDate.getTime()) || !cursorId) {
        return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
      }
      parsedAfter = { createdAt: cursorDate, id: cursorId };
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

    // Thread-replies branch: caller is opening a thread panel and wants the
    // ascending list of replies for one parent. The parent must belong to this
    // conversation and itself be top-level. `findActiveMessage` already filters
    // isActive=true, so a soft-deleted parent surfaces as 404 here. Mark-as-read
    // is intentionally NOT triggered — that belongs to the conversation stream,
    // not the panel.
    if (parentId) {
      const parent = await dmMessageRepository.findActiveMessage({
        messageId: parentId,
        conversationId,
      });
      if (!parent) {
        return NextResponse.json(
          { error: 'Parent message not found in this conversation' },
          { status: 404 }
        );
      }
      if (parent.parentId !== null) {
        return NextResponse.json(
          { error: 'Parent must be a top-level message' },
          { status: 400 }
        );
      }

      const [replies, followers] = await Promise.all([
        dmMessageRepository.listDmThreadReplies({
          rootId: parentId,
          limit: limit + 1,
          after: parsedAfter,
        }),
        dmMessageRepository.listDmThreadFollowers(parentId),
      ]);

      const hasMore = replies.length > limit;
      const page = hasMore ? replies.slice(0, limit) : replies;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last
        ? `${last.createdAt.toISOString()}|${last.id}`
        : null;

      const isFollowing = followers.includes(userId);

      auditRequest(request, {
        eventType: 'data.read',
        userId,
        resourceType: 'dm_thread',
        resourceId: parentId,
        details: { replyCount: page.length },
      });

      return NextResponse.json({ messages: page, nextCursor, hasMore, isFollowing });
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
    await Promise.all([
      dmMessageRepository.markActiveMessagesRead({
        conversationId,
        otherUserId,
        readAt,
      }),
      dmMessageRepository.updateConversationLastRead({
        conversationId,
        participantSide: conversation.participant1Id === userId ? 'participant1' : 'participant2',
        readAt,
      }),
    ]);

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
      parentId?: unknown;
      alsoSendToParent?: unknown;
    };

    const rawContent = typeof body.content === 'string' ? body.content : '';
    const content = rawContent.trim().length > 0 ? rawContent : '';
    const fileId = typeof body.fileId === 'string' && body.fileId.length > 0 ? body.fileId : null;
    const rawAttachmentMeta = body.attachmentMeta ?? null;
    const trimmedParent = typeof body.parentId === 'string' ? body.parentId.trim() : '';
    const parentId = trimmedParent.length > 0 ? trimmedParent : null;
    const alsoSendToParent = body.alsoSendToParent === true;

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

    // Thread reply branch: validated parent inserts go through the
    // transactional helper that bumps replyCount + lastReplyAt and upserts
    // followers. Mirror copy (alsoSendToParent) writes a second top-level row.
    if (parentId) {
      const result = await dmMessageRepository.insertDmThreadReply({
        parentId,
        conversationId,
        senderId: userId,
        content,
        fileId,
        attachmentMeta,
        alsoSendToParent,
      });

      if (result.kind === 'parent_not_found') {
        return NextResponse.json({ error: 'Parent message not found' }, { status: 404 });
      }
      if (result.kind === 'parent_wrong_conversation') {
        return NextResponse.json({ error: 'Parent message belongs to a different conversation' }, { status: 400 });
      }
      if (result.kind === 'parent_not_top_level') {
        return NextResponse.json({ error: 'Threads are exactly one level deep' }, { status: 400 });
      }

      auditRequest(request, {
        eventType: 'data.write',
        userId,
        resourceType: 'dm_thread_reply',
        resourceId: result.reply.id,
      });

      // Mirror row, when present, behaves as a top-level message — it should
      // bump the conversation preview/inbox just like a regular send. The
      // thread-only reply does NOT touch the inbox preview here; PR 5 wires
      // the inbox bump for thread followers separately.
      if (result.mirror) {
        const previewSource = buildLastMessagePreview(content, attachmentMeta);
        await dmMessageRepository.updateConversationLastMessage({
          conversationId,
          lastMessageAt: result.mirror.createdAt,
          lastMessagePreview: previewSource,
        });

        const recipientId = conversation.participant1Id === userId
          ? conversation.participant2Id
          : conversation.participant1Id;

        await createOrUpdateMessageNotification(
          recipientId,
          conversationId,
          previewSource,
          userId
        );

        await broadcastInboxEvent(recipientId, {
          operation: 'dm_updated',
          type: 'dm',
          id: conversationId,
          lastMessageAt: result.mirror.createdAt.toISOString(),
          lastMessagePreview: previewSource,
          attachmentMeta,
        });
      }

      if (process.env.INTERNAL_REALTIME_URL) {
        try {
          // Two events with distinct ids — clients dedupe on id, so a viewer of
          // both the thread panel and parent stream receives both copies cleanly.
          // 5s timeout matches broadcastThreadReplyCountUpdated — an unhealthy
          // realtime server must not stall the API response after the commit.
          const threadBody = JSON.stringify({
            channelId: `dm:${conversationId}`,
            event: 'new_dm_message',
            payload: result.reply,
          });
          await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
            method: 'POST',
            headers: createSignedBroadcastHeaders(threadBody),
            body: threadBody,
            signal: AbortSignal.timeout(5000),
          });

          if (result.mirror) {
            const mirrorBody = JSON.stringify({
              channelId: `dm:${conversationId}`,
              event: 'new_dm_message',
              payload: result.mirror,
            });
            await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
              method: 'POST',
              headers: createSignedBroadcastHeaders(mirrorBody),
              body: mirrorBody,
              signal: AbortSignal.timeout(5000),
            });
          }
        } catch (error) {
          loggers.realtime.error('Failed to broadcast DM thread reply to socket server:', error as Error);
        }
      }

      await broadcastThreadReplyCountUpdated(`dm:${conversationId}`, {
        rootId: result.rootId,
        replyCount: result.replyCount,
        lastReplyAt: result.lastReplyAt.toISOString(),
      });

      // PR 5: thread_updated inbox fan-out to followers, plus mentioned
      // non-follower DM-level bumps. Mirrors the channel route's logic at a
      // smaller scale — DMs only have two participants, so the "non-follower
      // mention" path is rare but kept for symmetry. Failures are logged and
      // swallowed; the DB commit is durable.
      try {
        const previewSource = buildLastMessagePreview(content, attachmentMeta);
        const replyCreatedAt = result.lastReplyAt.toISOString();
        const replySender = {
          id: userId,
          name: 'Member',
        };

        const followers = await dmMessageRepository.listDmThreadFollowers(result.rootId);
        const followerSet = new Set(followers);

        await Promise.all(
          followers
            .filter((followerId: string) => followerId !== userId)
            .map((followerId: string) =>
              broadcastInboxEvent(followerId, {
                operation: 'thread_updated',
                type: 'dm',
                id: conversationId,
                rootMessageId: result.rootId,
                lastReplyAt: replyCreatedAt,
                lastReplyPreview: previewSource,
                lastReplySender: replySender,
              })
            )
        );

        if (content.trim().length > 0) {
          const mentionedUserIds = extractMentionedUserIds(content);
          const mentionTargets = mentionedUserIds.filter(
            (id: string) => id !== userId && !followerSet.has(id)
          );
          await Promise.all(
            mentionTargets.map((memberId: string) =>
              broadcastInboxEvent(memberId, {
                operation: 'dm_updated',
                type: 'dm',
                id: conversationId,
                lastMessageAt: replyCreatedAt,
                lastMessagePreview: previewSource,
                attachmentMeta,
              })
            )
          );
        }
      } catch (error) {
        loggers.realtime.error('Failed to broadcast DM thread inbox update:', error as Error);
      }

      return NextResponse.json({ message: result.reply });
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

    // 5s timeout matches the thread-path broadcasts so an unhealthy realtime
    // server cannot stall the API response after the DB commit.
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
          signal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        loggers.realtime.error('Failed to broadcast DM message to socket server:', error as Error);
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
    await Promise.all([
      dmMessageRepository.markActiveMessagesRead({
        conversationId,
        otherUserId,
        readAt,
      }),
      dmMessageRepository.updateConversationLastRead({
        conversationId,
        participantSide: conversation.participant1Id === userId ? 'participant1' : 'participant2',
        readAt,
      }),
    ]);

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

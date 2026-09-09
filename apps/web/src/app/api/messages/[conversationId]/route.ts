import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logging/logger-config'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { createOrUpdateMessageNotification, markDmConversationNotificationsRead } from '@pagespace/lib/notifications/notifications'
import { isEmailVerified } from '@pagespace/lib/auth/verification-utils';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { dmMessageRepository } from '@pagespace/lib/services/dm-message-repository';
import { buildLastMessagePreview } from '@pagespace/lib/services/message-derived-state';
import { attachQuotedMessages } from '@pagespace/lib/services/quote-enrichment';
import { broadcastInboxEvent, broadcastThreadReplyCountUpdated } from '@/lib/websocket/socket-utils';
import { parseBoundedIntParam } from '@/lib/utils/query-params';
import { extractMentionedUserIds } from '@/lib/channels/extract-user-mentions';
import { MAX_MESSAGE_ATTACHMENTS, parseMessageAttachments } from '@pagespace/lib/services/attachment-upload-core';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

/**
 * Shared error mapping for the two attachment-validation call sites (the
 * thread-reply and top-level insert discriminated results) — both surface
 * the same three rejection kinds against the same fileId/conversationId
 * pair, just from different call shapes.
 */
function attachmentValidationErrorResponse(
  request: Request,
  kind: 'not_found' | 'wrong_owner' | 'not_linked' | 'too_many_attachments',
  ctx: { userId: string; fileId: string | null; conversationId: string }
): NextResponse {
  if (kind === 'not_found') {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
  if (kind === 'too_many_attachments') {
    return NextResponse.json(
      { error: `A message may carry at most ${MAX_MESSAGE_ATTACHMENTS} attachments` },
      { status: 400 }
    );
  }
  const isOwnerMismatch = kind === 'wrong_owner';
  auditRequest(request, {
    eventType: 'authz.access.denied',
    userId: ctx.userId,
    resourceType: 'dm_message',
    resourceId: ctx.fileId ?? undefined,
    details: {
      reason: isOwnerMismatch ? 'file_owner_mismatch' : 'file_not_linked_to_conversation',
      conversationId: ctx.conversationId,
    },
  });
  return NextResponse.json(
    { error: isOwnerMismatch ? 'You do not own this file' : 'File is not linked to this conversation' },
    { status: 403 }
  );
}

/**
 * Shared by the GET side-effect and the explicit PATCH.
 *
 * The notification clear runs on every call, independent of `markedCount` — a
 * NEW_DIRECT_MESSAGE notification can be unread even when its underlying
 * message row was already marked read (e.g. by a build predating this fix),
 * so gating the clear on `markedCount` would leave it orphaned forever.
 *
 * The inbox broadcast stays gated on `markedCount > 0` — a no-op poll must
 * not emit socket traffic (GET-path noise) — and runs AFTER the notification
 * write resolves, so a listener like `useSidebarBadges` that revalidates on
 * this event observes the post-write state rather than racing it.
 */
async function markDmConversationReadAndNotify(
  userId: string,
  conversationId: string,
  markedCount: number
): Promise<number> {
  const notificationsMarkedRead = await markDmConversationNotificationsRead(userId, conversationId);

  if (markedCount > 0) {
    await broadcastInboxEvent(userId, {
      operation: 'read_status_changed',
      type: 'dm',
      id: conversationId,
      unreadCount: 0,
    });
  }

  return notificationsMarkedRead;
}

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
    const [markedCount] = await Promise.all([
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

    const notificationsMarkedRead = await markDmConversationReadAndNotify(userId, conversationId, markedCount);

    // Show oldest first in the response payload.
    messages.reverse();

    // Enrich with denormalized quote snapshots; helper short-circuits when no
    // row carries a quotedMessageId so this is a no-op for quote-free pages.
    const enriched = await attachQuotedMessages(messages, 'dm');

    auditRequest(request, { eventType: 'data.read', userId, resourceType: 'message', resourceId: conversationId });

    return NextResponse.json({ messages: enriched, notificationsMarkedRead });
  } catch (error) {
    loggers.api.error('Error fetching messages:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch messages' },
      { status: 500 }
    );
  }
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
      quotedMessageId?: unknown;
      attachments?: unknown;
      clientNonce?: unknown;
    };

    const rawContent = typeof body.content === 'string' ? body.content : '';
    const content = rawContent.trim().length > 0 ? rawContent : '';
    const clientNonce = typeof body.clientNonce === 'string' ? body.clientNonce : undefined;

    // Accepts the new attachments array and the legacy singular fileId +
    // attachmentMeta pair, so the published SDK and CLI keep working.
    const parsedAttachments = parseMessageAttachments(body);
    if (parsedAttachments.kind === 'invalid') {
      return NextResponse.json({ error: parsedAttachments.error }, { status: 400 });
    }
    const attachments = parsedAttachments.attachments;
    const fileId = attachments[0]?.fileId ?? null;

    const trimmedParent = typeof body.parentId === 'string' ? body.parentId.trim() : '';
    const parentId = trimmedParent.length > 0 ? trimmedParent : null;
    const alsoSendToParent = body.alsoSendToParent === true;
    const trimmedQuoted = typeof body.quotedMessageId === 'string' ? body.quotedMessageId.trim() : '';
    const quotedMessageId = trimmedQuoted.length > 0 ? trimmedQuoted : null;

    if (content.length === 0 && attachments.length === 0) {
      return NextResponse.json(
        { error: 'Message content or file is required' },
        { status: 400 }
      );
    }

    // Preview/notification payloads below describe the whole batch, so a
    // five-photo DM reads "[5 images]" rather than one arbitrary filename.
    const attachmentMetas = attachments.map((a) => a.attachmentMeta);

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

    // Quote-reply validation. Quotes are top-level only — the quoted DM must
    // (a) belong to this conversation, (b) be active, and (c) itself be a
    // top-level message (parentId IS NULL). Same-conversation gating is the
    // only ACL check needed; participation was already verified above by
    // findConversationForParticipant.
    if (quotedMessageId) {
      if (parentId) {
        return NextResponse.json(
          { error: 'Quote replies cannot be combined with thread replies' },
          { status: 400 },
        );
      }
      const quoted = await dmMessageRepository.findActiveMessage({
        messageId: quotedMessageId,
        conversationId,
      });
      if (!quoted) {
        return NextResponse.json({ error: 'Quoted message not found' }, { status: 404 });
      }
      if (quoted.parentId !== null) {
        return NextResponse.json(
          { error: 'Threads are exactly one level deep' },
          { status: 400 },
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
        attachments,
        alsoSendToParent,
      });

      if (
        result.kind === 'not_found' ||
        result.kind === 'wrong_owner' ||
        result.kind === 'not_linked' ||
        result.kind === 'too_many_attachments'
      ) {
        return attachmentValidationErrorResponse(request, result.kind, {
          userId,
          fileId,
          conversationId,
        });
      }
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

      // insertDmThreadReply returns the bare inserted row, so — as on the
      // top-level path — the attachment rows have to be put back on before
      // the payload goes out over the socket or the response.
      const replyPayload = { ...result.reply, attachments: result.replyAttachments };

      // Mirror row, when present, behaves as a top-level message — it bumps
      // the conversation preview/inbox just like a regular send.
      // insertDmThreadReply already recomputed the stored preview from the
      // mirror row (#2153); this local copy is only for the
      // notification/broadcast payloads below. The thread-only reply does
      // NOT touch the inbox preview here; PR 5 wires the inbox bump for
      // thread followers separately.
      if (result.mirror) {
        const previewSource = buildLastMessagePreview(content, attachmentMetas);

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
          attachmentMeta: attachmentMetas[0] ?? null,
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
            // clientNonce rides the wire only — never a column. It lets the
            // sender retire exactly its own optimistic row instead of guessing
            // from (content, fileId), which cannot tell two attachment-only
            // messages apart.
            payload: { ...replyPayload, ...(clientNonce ? { clientNonce } : {}) },
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
              // A different row than the one optimistically inserted, so it
              // deliberately carries no nonce.
              payload: { ...result.mirror, attachments: result.mirrorAttachments },
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
        const previewSource = buildLastMessagePreview(content, attachmentMetas);
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

        // The mention-targeted bump is only meaningful for thread-only DM
        // replies. When `alsoSendToParent` is set, the mirror branch above
        // already fired `dm_updated` to the other participant — duplicating
        // it here would inflate their unread count by 2 instead of 1.
        const isThreadOnlyReply = !result.mirror;
        if (isThreadOnlyReply && content.trim().length > 0) {
          // DM mention IDs come from sender-controlled markup — the recipient
          // set MUST be intersected with the conversation's actual participants.
          // Without this, a sender could craft a `:user` mention for any user
          // id and trigger a `dm_updated` payload (containing the conversation
          // id, preview, and attachment metadata) to fan out to non-participants.
          const otherParticipantId =
            conversation.participant1Id === userId
              ? conversation.participant2Id
              : conversation.participant1Id;
          const allowedTargets = new Set<string>([otherParticipantId]);
          const mentionedUserIds = extractMentionedUserIds(content);
          const mentionTargets = mentionedUserIds.filter(
            (id: string) =>
              id !== userId && !followerSet.has(id) && allowedTargets.has(id)
          );
          await Promise.all(
            mentionTargets.map((memberId: string) =>
              broadcastInboxEvent(memberId, {
                operation: 'dm_updated',
                type: 'dm',
                id: conversationId,
                lastMessageAt: replyCreatedAt,
                lastMessagePreview: previewSource,
                attachmentMeta: attachmentMetas[0] ?? null,
              })
            )
          );
        }
      } catch (error) {
        loggers.realtime.error('Failed to broadcast DM thread inbox update:', error as Error);
      }

      return NextResponse.json({
        message: { ...replyPayload, ...(clientNonce ? { clientNonce } : {}) },
      });
    }

    // Validates the attachment (if any) and inserts the message atomically —
    // see insertDmMessageWithAttachment's doc comment for why the split
    // validate-then-insert this replaces was unsafe.
    const insertResult = await dmMessageRepository.insertDmMessageWithAttachment({
      conversationId,
      senderId: userId,
      content,
      attachments,
      quotedMessageId,
    });

    if (insertResult.kind !== 'ok') {
      return attachmentValidationErrorResponse(request, insertResult.kind, {
        userId,
        fileId,
        conversationId,
      });
    }

    // The insert returns the bare row, so — unlike the channel route, which
    // re-loads through the shared `with` clause — the attachment rows have to
    // be put back on by hand here. Without this the recipient's socket payload
    // would carry an empty bubble until they refreshed.
    //
    // These rows carry no joined `file`, and deliberately so: every field the
    // renderer needs (mime type, size, name) is in attachmentMeta, and
    // re-reading each file to populate a relation nothing reads would add a
    // round trip after the commit for no gain.
    const baseMessage = { ...insertResult.message, attachments: insertResult.attachments };
    // Enrich with the quote snapshot so the realtime payload and the JSON
    // response carry the same denormalized shape the GET list returns.
    const [newMessage] = await attachQuotedMessages([baseMessage], 'dm');

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'message',
      resourceId: newMessage.id,
    });

    // insertDmMessageWithAttachment already recomputed the stored preview
    // (#2153); this local copy is only for the notification/broadcast
    // payloads below.
    const messagePreview = buildLastMessagePreview(content, attachmentMetas);

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
          payload: clientNonce ? { ...newMessage, clientNonce } : newMessage,
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
      attachmentMeta: attachmentMetas[0] ?? null,
    });

    auditRequest(request, {
      eventType: 'data.write',
      userId,
      resourceType: 'conversation',
      resourceId: conversationId,
    });

    return NextResponse.json({
      message: clientNonce ? { ...newMessage, clientNonce } : newMessage,
    });
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
    const [markedCount] = await Promise.all([
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

    const notificationsMarkedRead = await markDmConversationReadAndNotify(userId, conversationId, markedCount);

    auditRequest(request, { eventType: 'data.write', userId, resourceType: 'message', resourceId: conversationId, details: { operation: 'mark_read' } });

    return NextResponse.json({ success: true, notificationsMarkedRead });
  } catch (error) {
    loggers.api.error('Error marking messages as read:', error as Error);
    return NextResponse.json(
      { error: 'Failed to mark messages as read' },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { db } from '@pagespace/db/db'
import { eq, and, or, isNull, gt, inArray } from '@pagespace/db/operators'
import { pages } from '@pagespace/db/schema/core'
import { driveMembers, pagePermissions } from '@pagespace/db/schema/members'
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/permissions/permissions'
import { auditRequest } from '@pagespace/lib/audit/audit-log';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { createSignedBroadcastHeaders } from '@pagespace/lib/auth/broadcast-auth';
import { broadcastInboxEvent, broadcastThreadReplyCountUpdated } from '@/lib/websocket/socket-utils';
import { channelMessageRepository } from '@pagespace/lib/services/channel-message-repository';
import type { AttachmentMeta } from '@pagespace/lib/types';

const AUTH_OPTIONS_READ = { allow: ['session', 'mcp'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session', 'mcp'] as const, requireCSRF: true };

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  // Check MCP page scope
  const scopeError = await checkMCPPageScope(auth, pageId);
  if (scopeError) return scopeError;

  // Check if user has view permission for this channel
  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    return NextResponse.json({
      error: 'You need view permission to access this channel',
      details: 'Contact the channel owner to request access'
    }, { status: 403 });
  }

  // Pagination params
  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get('cursor');
  const rawParentId = searchParams.get('parentId');
  const parentId = rawParentId ? rawParentId.trim() : '';
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10) || 50, 1), 200);

  let parsedCursor: { createdAt: Date; id: string } | undefined;
  if (cursor) {
    const separatorIdx = cursor.lastIndexOf('|');
    if (separatorIdx === -1) {
      return NextResponse.json({ error: 'Invalid cursor format' }, { status: 400 });
    }
    const cursorDate = new Date(cursor.slice(0, separatorIdx));
    const cursorId = cursor.slice(separatorIdx + 1);
    if (isNaN(cursorDate.getTime()) || !cursorId) {
      return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
    }
    parsedCursor = { createdAt: cursorDate, id: cursorId };
  }

  // Thread-replies branch: caller is opening a thread panel and wants the
  // ascending list of replies to a single top-level parent. The parent must
  // belong to this page, be active, and itself be top-level (depth-1 only).
  if (parentId) {
    const parent = await channelMessageRepository.findChannelMessageInPage({
      messageId: parentId,
      pageId,
    });
    // Treat soft-deleted parents the same as missing parents — clients should
    // not be able to enumerate replies of a tombstoned thread root.
    if (!parent || !parent.isActive) {
      return NextResponse.json({ error: 'Parent message not found in this channel' }, { status: 404 });
    }
    if (parent.parentId !== null) {
      return NextResponse.json({ error: 'Parent must be a top-level message' }, { status: 400 });
    }

    const replies = await channelMessageRepository.listChannelThreadReplies({
      rootId: parentId,
      limit: limit + 1,
      after: parsedCursor,
    });

    const hasMore = replies.length > limit;
    const page = hasMore ? replies.slice(0, limit) : replies;
    // Ascending cursor: next page starts strictly after the last row.
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? `${last.createdAt.toISOString()}|${last.id}`
      : null;

    auditRequest(req, { eventType: 'data.read', userId: auth.userId, resourceType: 'channel_thread', resourceId: parentId, details: { replyCount: page.length } });

    return NextResponse.json({ messages: page, nextCursor, hasMore });
  }

  // Fetch limit+1 in DESC order to determine if more exist, then reverse for chronological display
  const messages = await channelMessageRepository.listChannelMessages({
    pageId,
    limit: limit + 1,
    cursor: parsedCursor,
  });

  const hasMore = messages.length > limit;
  const page = hasMore ? messages.slice(0, limit) : messages;
  // Reverse to chronological order (oldest first) for display
  page.reverse();

  // Composite cursor: createdAt|id
  const nextCursor = hasMore && page.length > 0
    ? `${page[0].createdAt.toISOString()}|${page[0].id}`
    : null;

  auditRequest(req, { eventType: 'data.read', userId: auth.userId, resourceType: 'channel', resourceId: pageId, details: { messageCount: page.length } });

  return NextResponse.json({ messages: page, nextCursor, hasMore });
}

export async function POST(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  // Check MCP page scope
  const writeScopeError = await checkMCPPageScope(auth, pageId);
  if (writeScopeError) return writeScopeError;

  // Check if user has edit permission to post messages in this channel
  const canEdit = await canUserEditPage(userId, pageId);
  if (!canEdit) {
    return NextResponse.json({
      error: 'You need edit permission to send messages in this channel',
      details: 'Only channel members with edit access can send messages'
    }, { status: 403 });
  }

  const { content, fileId, attachmentMeta, parentId: rawParentId, alsoSendToParent } = await req.json() as {
    content: string;
    fileId?: string;
    attachmentMeta?: AttachmentMeta;
    parentId?: string;
    alsoSendToParent?: boolean;
  };
  const messageContent = typeof content === 'string' ? content : '';
  const parentId = typeof rawParentId === 'string' ? rawParentId.trim() : '';

  // Debug: Check what content type is being received
  loggers.realtime.debug('API received content type:', { type: typeof content });
  loggers.realtime.debug('API received content:', { content, fileId });

  // If fileId is provided, verify it exists
  if (fileId) {
    const exists = await channelMessageRepository.fileExists(fileId);
    if (!exists) {
      return NextResponse.json({ error: 'File not found' }, { status: 400 });
    }
  }

  // Thread reply branch: validate the parent and route through the
  // transactional helper that bumps replyCount + lastReplyAt and upserts
  // followers in one shot. Mirror copy (alsoSendToParent) writes a second
  // top-level row so the parent stream sees it too.
  if (parentId.length > 0) {
    const result = await channelMessageRepository.insertChannelThreadReply({
      parentId,
      pageId,
      userId,
      content: messageContent,
      fileId: fileId || null,
      attachmentMeta: attachmentMeta || null,
      alsoSendToParent: alsoSendToParent === true,
    });

    if (result.kind === 'parent_not_found') {
      return NextResponse.json({ error: 'Parent message not found' }, { status: 404 });
    }
    if (result.kind === 'parent_wrong_page') {
      return NextResponse.json({ error: 'Parent message belongs to a different channel' }, { status: 400 });
    }
    if (result.kind === 'parent_not_top_level') {
      return NextResponse.json({ error: 'Threads are exactly one level deep' }, { status: 400 });
    }

    // Sender's own read status — sending counts as reading.
    await channelMessageRepository.upsertChannelReadStatus({
      userId,
      channelId: pageId,
      readAt: new Date(),
    });

    const replyWithRelations = await channelMessageRepository.loadChannelMessageWithRelations(result.reply.id);
    const mirrorWithRelations = result.mirror
      ? await channelMessageRepository.loadChannelMessageWithRelations(result.mirror.id)
      : null;

    if (process.env.INTERNAL_REALTIME_URL) {
      try {
        // Two events with distinct ids — clients dedupe on id, so a viewer of
        // both the thread panel and parent stream receives both copies cleanly.
        // 5s timeout matches broadcastThreadReplyCountUpdated and the other
        // socket-utils helpers — an unhealthy realtime server must not stall
        // the API response after the DB commit.
        const thread = JSON.stringify({
          channelId: pageId,
          event: 'new_message',
          payload: replyWithRelations,
        });
        await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
          method: 'POST',
          headers: createSignedBroadcastHeaders(thread),
          body: thread,
          signal: AbortSignal.timeout(5000),
        });

        if (mirrorWithRelations) {
          const mirror = JSON.stringify({
            channelId: pageId,
            event: 'new_message',
            payload: mirrorWithRelations,
          });
          await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
            method: 'POST',
            headers: createSignedBroadcastHeaders(mirror),
            body: mirror,
            signal: AbortSignal.timeout(5000),
          });
        }
      } catch (error) {
        loggers.realtime.error('Failed to broadcast thread reply to socket server:', error as Error);
      }
    }

    await broadcastThreadReplyCountUpdated(pageId, {
      rootId: result.rootId,
      replyCount: result.replyCount,
      lastReplyAt: result.lastReplyAt.toISOString(),
    });

    return NextResponse.json(replyWithRelations, { status: 201 });
  }

  const createdMessage = await channelMessageRepository.insertChannelMessage({
    pageId,
    userId,
    content: messageContent,
    fileId: fileId || null,
    attachmentMeta: attachmentMeta || null,
  });

  // Update sender's read status - sending a message means they've read the channel
  await channelMessageRepository.upsertChannelReadStatus({
    userId,
    channelId: pageId,
    readAt: new Date(),
  });

  const newMessage = await channelMessageRepository.loadChannelMessageWithRelations(createdMessage.id);

  // Debug: Check what type the content is
  loggers.realtime.debug('Database returned content type:', { type: typeof newMessage?.content });
  loggers.realtime.debug('Database returned content:', { content: newMessage?.content });

  // Broadcast the new message to the channel
  if (process.env.INTERNAL_REALTIME_URL) {
    try {
      const requestBody = JSON.stringify({
        channelId: pageId,
        event: 'new_message',
        payload: newMessage,
      });

      await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
        method: 'POST',
        headers: createSignedBroadcastHeaders(requestBody),
        body: requestBody,
      });
    } catch (error) {
      loggers.realtime.error('Failed to broadcast message to socket server:', error as Error);
    }
  }

  // Broadcast inbox update to channel members who have view permission
  try {
    // Get channel's driveId and drive owner
    const channel = await db.query.pages.findFirst({
      where: eq(pages.id, pageId),
      columns: { driveId: true, title: true },
      with: {
        drive: {
          columns: { ownerId: true, name: true, slug: true },
        },
      },
    });

    if (messageContent.trim().length > 0) {
      void import('@/lib/channels/agent-mention-responder')
        .then(({ triggerMentionedAgentResponses }) =>
          triggerMentionedAgentResponses({
            userId,
            channelId: pageId,
            channelTitle: channel?.title || 'Channel',
            channelType: 'CHANNEL',
            sourceMessageId: createdMessage.id,
            content: messageContent,
            driveId: channel?.driveId || null,
            driveName: channel?.drive?.name || null,
            driveSlug: channel?.drive?.slug || null,
          })
        )
        .catch((error) => {
          loggers.realtime.error('Failed to load channel mention responder module:', error as Error);
        });
    }

    if (channel?.driveId) {
      // Get all drive members
      const members = await db.query.driveMembers.findMany({
        where: eq(driveMembers.driveId, channel.driveId),
        columns: { userId: true },
      });

      // Include drive owner in recipient list (if not already a member)
      const driveOwnerId = channel.drive?.ownerId;
      const memberUserIds = new Set(members.map(m => m.userId));
      if (driveOwnerId && !memberUserIds.has(driveOwnerId)) {
        members.push({ userId: driveOwnerId });
      }

      // Create message preview
      const messagePreview = messageContent.length > 100
        ? messageContent.substring(0, 100) + '...'
        : messageContent;

      // Batch permission check: mirrors getUserAccessLevel logic from @pagespace/lib.
      // If that logic changes (e.g. new roles), update this batch version in sync.
      // Drive owner and admins always have access; others need explicit page permissions.
      const otherMemberIds = members
        .filter(m => m.userId !== userId)
        .map(m => m.userId);

      let viewableUserIds: Set<string>;
      if (otherMemberIds.length === 0) {
        viewableUserIds = new Set();
      } else {
        // Drive owner always has access
        viewableUserIds = new Set<string>();
        if (driveOwnerId && otherMemberIds.includes(driveOwnerId)) {
          viewableUserIds.add(driveOwnerId);
        }

        // Drive admins always have access
        const adminMembers = await db.select({ userId: driveMembers.userId })
          .from(driveMembers)
          .where(and(
            eq(driveMembers.driveId, channel.driveId),
            inArray(driveMembers.userId, otherMemberIds),
            eq(driveMembers.role, 'ADMIN')
          ));
        for (const admin of adminMembers) {
          viewableUserIds.add(admin.userId);
        }

        // Check explicit page permissions for remaining members
        const remainingIds = otherMemberIds.filter(id => !viewableUserIds.has(id));
        if (remainingIds.length > 0) {
          const permittedMembers = await db.select({ userId: pagePermissions.userId })
            .from(pagePermissions)
            .where(and(
              eq(pagePermissions.pageId, pageId),
              inArray(pagePermissions.userId, remainingIds),
              eq(pagePermissions.canView, true),
              or(isNull(pagePermissions.expiresAt), gt(pagePermissions.expiresAt, new Date()))
            ));
          for (const pm of permittedMembers) {
            viewableUserIds.add(pm.userId);
          }
        }
      }

      const broadcastPromises = otherMemberIds
        .filter(id => viewableUserIds.has(id))
        .map(memberId =>
          broadcastInboxEvent(memberId, {
            operation: 'channel_updated',
            type: 'channel',
            id: pageId,
            driveId: channel.driveId,
            lastMessageAt: newMessage?.createdAt?.toISOString() || new Date().toISOString(),
            lastMessagePreview: messagePreview,
            lastMessageSender: newMessage?.aiMeta?.senderName || newMessage?.user?.name || undefined,
          })
        );

      await Promise.all(broadcastPromises);

      // Broadcast read status change to sender to update their unread count
      await broadcastInboxEvent(userId, {
        operation: 'read_status_changed',
        type: 'channel',
        id: pageId,
        driveId: channel.driveId,
        unreadCount: 0,
      });
    }
  } catch (error) {
    loggers.realtime.error('Failed to broadcast inbox update:', error as Error);
  }

  return NextResponse.json(newMessage, { status: 201 });
}

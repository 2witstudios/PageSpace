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
import { extractMentionedUserIds } from '@/lib/channels/extract-user-mentions';
import { buildThreadPreview } from '@pagespace/lib/services/preview';
import type { AttachmentMeta } from '@pagespace/lib/types';

interface ChannelInboxFanoutInput {
  pageId: string;
  driveId: string;
  driveOwnerId: string | null | undefined;
  senderUserId: string;
  lastMessageAt: string;
  lastMessagePreview: string;
  lastMessageSender: string | undefined;
}

/**
 * Fans out `channel_updated` to every drive member who can view the channel
 * (excluding the sender). Mirrors the auth/permission logic of the top-level
 * POST path so a thread reply with `alsoSendToParent=true` can drive the same
 * channel-level inbox bump as a regular send.
 *
 * Returns the set of viewable user IDs so callers can use it to skip duplicate
 * bumps (e.g. when also targeting mentioned non-follower recipients).
 */
async function fanOutChannelInboxUpdate(
  input: ChannelInboxFanoutInput
): Promise<Set<string>> {
  const { pageId, driveId, driveOwnerId, senderUserId } = input;

  const driveMembersRows = await db.query.driveMembers.findMany({
    where: eq(driveMembers.driveId, driveId),
    columns: { userId: true },
  });

  // Build a local member set so we never mutate the ORM-returned array.
  // Drive owner is always a recipient even if they have no explicit row.
  const memberUserIds = new Set(driveMembersRows.map((m) => m.userId));
  if (driveOwnerId) {
    memberUserIds.add(driveOwnerId);
  }
  const otherMemberIds = [...memberUserIds].filter((id) => id !== senderUserId);

  const viewableUserIds = new Set<string>();
  if (otherMemberIds.length === 0) {
    return viewableUserIds;
  }

  if (driveOwnerId && otherMemberIds.includes(driveOwnerId)) {
    viewableUserIds.add(driveOwnerId);
  }

  const adminMembers = await db.select({ userId: driveMembers.userId })
    .from(driveMembers)
    .where(and(
      eq(driveMembers.driveId, driveId),
      inArray(driveMembers.userId, otherMemberIds),
      eq(driveMembers.role, 'ADMIN')
    ));
  for (const admin of adminMembers) {
    viewableUserIds.add(admin.userId);
  }

  const remainingIds = otherMemberIds.filter((id) => !viewableUserIds.has(id));
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

  await Promise.all(
    otherMemberIds
      .filter((id) => viewableUserIds.has(id))
      .map((memberId) =>
        broadcastInboxEvent(memberId, {
          operation: 'channel_updated',
          type: 'channel',
          id: pageId,
          driveId,
          lastMessageAt: input.lastMessageAt,
          lastMessagePreview: input.lastMessagePreview,
          lastMessageSender: input.lastMessageSender,
        })
      )
  );

  return viewableUserIds;
}

// Local alias kept so the existing call sites in this file stay terse.
const buildPreview = buildThreadPreview;

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

    const [replies, followers] = await Promise.all([
      channelMessageRepository.listChannelThreadReplies({
        rootId: parentId,
        limit: limit + 1,
        after: parsedCursor,
      }),
      channelMessageRepository.listChannelThreadFollowers(parentId),
    ]);

    const hasMore = replies.length > limit;
    const page = hasMore ? replies.slice(0, limit) : replies;
    // Ascending cursor: next page starts strictly after the last row.
    const last = page[page.length - 1];
    const nextCursor = hasMore && last
      ? `${last.createdAt.toISOString()}|${last.id}`
      : null;

    // Reflect the persisted follower row, not just local state, per PR 5's
    // locked requirement. The follow toggle in the panel header reads this.
    const isFollowing = followers.includes(userId);

    auditRequest(req, { eventType: 'data.read', userId: auth.userId, resourceType: 'channel_thread', resourceId: parentId, details: { replyCount: page.length } });

    return NextResponse.json({ messages: page, nextCursor, hasMore, isFollowing });
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

    // Intentionally NO read-status upsert on the thread path: replying in a
    // thread is not the same as reading the channel. The non-thread POST path
    // upserts read-status and broadcasts read_status_changed; doing the upsert
    // here without the matching broadcast would leave the sender's other tabs
    // showing a stale unread badge until refresh, AND it would falsely mark
    // unread top-level messages as read just because the sender posted in a
    // thread. PR 4 will surface a thread-specific read receipt instead.

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

    // PR 5: thread_updated inbox fan-out + selective channel-level bumps.
    //
    // Followers of the root receive a `thread_updated` inbox event so they can
    // surface an unread-thread badge on the channel row WITHOUT bumping the
    // top-level channel unread (a thread reply is not a top-level message).
    //
    // The reply author is excluded — we never notify someone of their own post.
    // PR 3's `insertChannelThreadReply` upserts `(parentAuthor, replier)` into
    // `channelThreadFollowers`, so by the time we read followers below, both
    // the parent author and the current replier are guaranteed to be in the
    // set; filtering out the replier is what excludes self-notifications.
    //
    // Failure handling: any of these broadcasts may fail because the realtime
    // sidecar is unhealthy. We log and continue — the DB commit is already
    // durable and a missed inbox bump is recoverable on the next refresh.
    try {
      const replyContent = messageContent;
      const replyPreview = buildPreview(replyContent);
      const replySender = {
        id: userId,
        name:
          replyWithRelations?.aiMeta?.senderName ||
          replyWithRelations?.user?.name ||
          'Member',
      };
      const replyCreatedAt = result.lastReplyAt.toISOString();

      const followers = await channelMessageRepository.listChannelThreadFollowers(result.rootId);
      const followerSet = new Set(followers);

      await Promise.all(
        followers
          .filter((followerId: string) => followerId !== userId)
          .map((followerId: string) =>
            broadcastInboxEvent(followerId, {
              operation: 'thread_updated',
              type: 'channel',
              id: pageId,
              rootMessageId: result.rootId,
              lastReplyAt: replyCreatedAt,
              lastReplyPreview: replyPreview,
              lastReplySender: replySender,
            })
          )
      );

      // Channel-level unread for thread replies is suppressed by default;
      // the two exceptions are (a) `alsoSendToParent` (the mirror is a real
      // top-level message) and (b) `@`-mentions of users who are NOT followers
      // of the thread, which need to surface in the channel row's main unread.
      //
      // For (b) we use the simpler safe rule from the plan: bump
      // `channel_updated` for mentioned users specifically (never broadly),
      // because broad scanning for non-follower mentions is brittle.
      const channel = await db.query.pages.findFirst({
        where: eq(pages.id, pageId),
        columns: { driveId: true, title: true },
        with: {
          drive: {
            columns: { ownerId: true, name: true, slug: true },
          },
        },
      });

      // The mention-targeted bump is only meaningful for thread-only replies.
      // When `alsoSendToParent` is set, the mirror row triggers the broad
      // `fanOutChannelInboxUpdate` below, which already reaches every viewable
      // member including the mentioned user — running this targeted path too
      // would deliver a duplicate `channel_updated` for the same underlying
      // event, inflating the recipient's unread count by 2 instead of 1.
      const isThreadOnlyReply = !mirrorWithRelations;
      if (isThreadOnlyReply && replyContent.trim().length > 0 && channel?.driveId) {
        const mentionedUserIds = extractMentionedUserIds(replyContent);
        const candidateTargets = mentionedUserIds.filter(
          (id: string) => id !== userId && !followerSet.has(id)
        );

        // Mention IDs come from message text, which is sender-controlled — so
        // before we broadcast a channel_updated payload (which leaks the channel
        // id, drive id, preview, and sender name), every candidate must pass
        // the channel's view-permission check. Without this gate a sender could
        // craft mentions for arbitrary user IDs and surface this channel to
        // users who have no access.
        const viewabilityChecks = await Promise.all(
          candidateTargets.map(async (id: string) => ({
            id,
            canView: await canUserViewPage(id, pageId),
          }))
        );
        const mentionTargets = viewabilityChecks
          .filter((entry) => entry.canView)
          .map((entry) => entry.id);

        await Promise.all(
          mentionTargets.map((memberId: string) =>
            broadcastInboxEvent(memberId, {
              operation: 'channel_updated',
              type: 'channel',
              id: pageId,
              driveId: channel.driveId!,
              lastMessageAt: replyCreatedAt,
              lastMessagePreview: replyPreview,
              lastMessageSender: replySender.name,
            })
          )
        );
      }

      if (mirrorWithRelations && channel?.driveId) {
        const mirrorPreview = buildPreview(replyContent);
        await fanOutChannelInboxUpdate({
          pageId,
          driveId: channel.driveId,
          driveOwnerId: channel.drive?.ownerId ?? null,
          senderUserId: userId,
          lastMessageAt: mirrorWithRelations.createdAt
            ? new Date(mirrorWithRelations.createdAt).toISOString()
            : replyCreatedAt,
          lastMessagePreview: mirrorPreview,
          lastMessageSender: replySender.name,
        });
      }

      // Mention-responder: an @-mentioned AI agent inside a thread should
      // reply IN THE THREAD, not at the top level. The responder is loaded
      // dynamically (same as the top-level path) so a build-time circular
      // dep cannot wire itself in at module load.
      if (replyContent.trim().length > 0) {
        void import('@/lib/channels/agent-mention-responder')
          .then(({ triggerMentionedAgentResponses }) =>
            triggerMentionedAgentResponses({
              userId,
              channelId: pageId,
              channelTitle: channel?.title || 'Channel',
              channelType: 'CHANNEL',
              sourceMessageId: result.reply.id,
              content: replyContent,
              parentId: result.rootId,
              driveId: channel?.driveId || null,
              driveName: channel?.drive?.name || null,
              driveSlug: channel?.drive?.slug || null,
            })
          )
          .catch((error) => {
            loggers.realtime.error('Failed to load channel mention responder module:', error as Error);
          });
      }
    } catch (error) {
      loggers.realtime.error('Failed to broadcast thread inbox update:', error as Error);
    }

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

  // Broadcast the new message to the channel.
  // 5s timeout matches the thread-path broadcasts so an unhealthy realtime
  // server cannot stall the API response after the DB commit.
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
        signal: AbortSignal.timeout(5000),
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
      const messagePreview = buildPreview(messageContent);

      await fanOutChannelInboxUpdate({
        pageId,
        driveId: channel.driveId,
        driveOwnerId: channel.drive?.ownerId ?? null,
        senderUserId: userId,
        lastMessageAt: newMessage?.createdAt?.toISOString() || new Date().toISOString(),
        lastMessagePreview: messagePreview,
        lastMessageSender: newMessage?.aiMeta?.senderName || newMessage?.user?.name || undefined,
      });

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

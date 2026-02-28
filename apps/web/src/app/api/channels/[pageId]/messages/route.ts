import { NextResponse } from 'next/server';
import { channelMessages, channelReadStatus, db, eq, and, desc, or, isNull, gt, lt, inArray, files, pages, driveMembers, pagePermissions } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError, checkMCPPageScope } from '@/lib/auth';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { createSignedBroadcastHeaders } from '@pagespace/lib/broadcast-auth';
import { broadcastInboxEvent } from '@/lib/websocket/socket-utils';

// Type for attachment metadata stored in the database
interface AttachmentMeta {
  originalName: string;
  size: number;
  mimeType: string;
  contentHash: string;
}

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
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '50', 10) || 50, 1), 200);

  // Build where clause with optional composite cursor (createdAt|id)
  const conditions = [eq(channelMessages.pageId, pageId), eq(channelMessages.isActive, true)];
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
    // Composite cursor: (createdAt < cursorDate) OR (createdAt = cursorDate AND id < cursorId)
    conditions.push(
      or(
        lt(channelMessages.createdAt, cursorDate),
        and(eq(channelMessages.createdAt, cursorDate), lt(channelMessages.id, cursorId))
      )!
    );
  }

  // Fetch limit+1 in DESC order to determine if more exist, then reverse for chronological display
  const messages = await db.query.channelMessages.findMany({
    where: and(...conditions),
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          image: true,
        },
      },
      file: {
        columns: {
          id: true,
          mimeType: true,
          sizeBytes: true,
        },
      },
      reactions: {
        with: {
          user: {
            columns: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
    orderBy: [desc(channelMessages.createdAt), desc(channelMessages.id)],
    limit: limit + 1,
  });

  const hasMore = messages.length > limit;
  const page = hasMore ? messages.slice(0, limit) : messages;
  // Reverse to chronological order (oldest first) for display
  page.reverse();

  // Composite cursor: createdAt|id
  const nextCursor = hasMore && page.length > 0
    ? `${page[0].createdAt.toISOString()}|${page[0].id}`
    : null;

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
  const canEdit = await canUserEditPage(userId, pageId, { bypassCache: true });
  if (!canEdit) {
    return NextResponse.json({
      error: 'You need edit permission to send messages in this channel',
      details: 'Only channel members with edit access can send messages'
    }, { status: 403 });
  }

  const { content, fileId, attachmentMeta } = await req.json() as {
    content: string;
    fileId?: string;
    attachmentMeta?: AttachmentMeta;
  };
  const messageContent = typeof content === 'string' ? content : '';

  // Debug: Check what content type is being received
  loggers.realtime.debug('API received content type:', { type: typeof content });
  loggers.realtime.debug('API received content:', { content, fileId });

  // If fileId is provided, verify it exists
  if (fileId) {
    const file = await db.query.files.findFirst({
      where: eq(files.id, fileId),
    });
    if (!file) {
      return NextResponse.json({ error: 'File not found' }, { status: 400 });
    }
  }

  const [createdMessage] = await db.insert(channelMessages).values({
    pageId: pageId,
    userId: userId,
    content: messageContent,
    fileId: fileId || null,
    attachmentMeta: attachmentMeta || null,
  }).returning();

  // Update sender's read status - sending a message means they've read the channel
  await db
    .insert(channelReadStatus)
    .values({ userId, channelId: pageId, lastReadAt: new Date() })
    .onConflictDoUpdate({
      target: [channelReadStatus.userId, channelReadStatus.channelId],
      set: { lastReadAt: new Date() },
    });

  const newMessage = await db.query.channelMessages.findFirst({
      where: eq(channelMessages.id, createdMessage.id),
      with: {
          user: {
              columns: {
                  id: true,
                  name: true,
                  image: true,
              }
          },
          file: {
              columns: {
                  id: true,
                  mimeType: true,
                  sizeBytes: true,
              }
          },
          reactions: {
              with: {
                  user: {
                      columns: {
                          id: true,
                          name: true,
                      },
                  },
              },
          },
      }
  });

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

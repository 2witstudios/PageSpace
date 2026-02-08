import { NextResponse } from 'next/server';
import { channelMessages, db, eq, asc, files, pages, driveMembers, sql } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
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

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['session'] as const, requireCSRF: true };

export async function GET(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_READ);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  // Check if user has view permission for this channel
  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    return NextResponse.json({ 
      error: 'You need view permission to access this channel',
      details: 'Contact the channel owner to request access'
    }, { status: 403 });
  }

  const messages = await db.query.channelMessages.findMany({
    where: eq(channelMessages.pageId, pageId),
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
    orderBy: [asc(channelMessages.createdAt)],
  });
  return NextResponse.json(messages);
}

export async function POST(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS_WRITE);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  // Check if user has edit permission to post messages in this channel
  const canEdit = await canUserEditPage(userId, pageId);
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
    content,
    fileId: fileId || null,
    attachmentMeta: attachmentMeta || null,
  }).returning();

  // Update sender's read status - sending a message means they've read the channel
  await db.execute(sql`
    INSERT INTO channel_read_status ("userId", "channelId", "lastReadAt")
    VALUES (${userId}, ${pageId}, NOW())
    ON CONFLICT ("userId", "channelId")
    DO UPDATE SET "lastReadAt" = NOW()
  `);

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
          columns: { ownerId: true },
        },
      },
    });

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
      const messagePreview = content.length > 100
        ? content.substring(0, 100) + '...'
        : content;

      // Filter to members with view permission and broadcast
      // Check permissions in parallel for efficiency
      const memberPermissions = await Promise.all(
        members
          .filter(m => m.userId !== userId)
          .map(async member => ({
            userId: member.userId,
            canView: await canUserViewPage(member.userId, pageId),
          }))
      );

      const broadcastPromises = memberPermissions
        .filter(m => m.canView)
        .map(member =>
          broadcastInboxEvent(member.userId, {
            operation: 'channel_updated',
            type: 'channel',
            id: pageId,
            driveId: channel.driveId,
            lastMessageAt: newMessage?.createdAt?.toISOString() || new Date().toISOString(),
            lastMessagePreview: messagePreview,
            lastMessageSender: newMessage?.user?.name || undefined,
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
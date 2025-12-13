import { NextResponse } from 'next/server';
import { channelMessages, db, eq, asc } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage, canUserEditPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { createSignedBroadcastHeaders } from '@pagespace/lib/broadcast-auth';

const AUTH_OPTIONS_READ = { allow: ['jwt'] as const, requireCSRF: false };
const AUTH_OPTIONS_WRITE = { allow: ['jwt'] as const, requireCSRF: true };

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
          name: true,
          image: true,
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

  const { content } = await req.json();
  
  // Debug: Check what content type is being received
  loggers.realtime.debug('API received content type:', { type: typeof content });
  loggers.realtime.debug('API received content:', { content });
  const [createdMessage] = await db.insert(channelMessages).values({
    pageId: pageId,
    userId: userId,
    content,
  }).returning();

  const newMessage = await db.query.channelMessages.findFirst({
      where: eq(channelMessages.id, createdMessage.id),
      with: {
          user: {
              columns: {
                  name: true,
                  image: true,
              }
          }
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

  return NextResponse.json(newMessage, { status: 201 });
}
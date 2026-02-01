import { NextResponse } from 'next/server';
import { channelMessages, channelMessageReactions, db, eq, and } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { canUserViewPage } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { createSignedBroadcastHeaders } from '@pagespace/lib/broadcast-auth';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: true };

type RouteParams = { params: Promise<{ pageId: string; messageId: string }> };

/**
 * POST /api/channels/[pageId]/messages/[messageId]/reactions
 * Add a reaction to a message
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { pageId, messageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  // Check if user has view permission (reactions require at least view access)
  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    return NextResponse.json({
      error: 'You need view permission to react to messages',
      details: 'Contact the channel owner to request access'
    }, { status: 403 });
  }

  const { emoji } = await req.json();

  if (!emoji || typeof emoji !== 'string') {
    return NextResponse.json({ error: 'Emoji is required' }, { status: 400 });
  }

  // Verify message exists and belongs to this channel
  const message = await db.query.channelMessages.findFirst({
    where: and(
      eq(channelMessages.id, messageId),
      eq(channelMessages.pageId, pageId)
    ),
  });

  if (!message) {
    return NextResponse.json({ error: 'Message not found' }, { status: 404 });
  }

  // Insert reaction (unique constraint will prevent duplicates)
  try {
    const [reaction] = await db.insert(channelMessageReactions).values({
      messageId,
      userId,
      emoji,
    }).returning();

    // Fetch with user info for broadcast
    const reactionWithUser = await db.query.channelMessageReactions.findFirst({
      where: eq(channelMessageReactions.id, reaction.id),
      with: {
        user: {
          columns: {
            id: true,
            name: true,
          },
        },
      },
    });

    // Broadcast reaction to channel
    if (process.env.INTERNAL_REALTIME_URL) {
      try {
        const requestBody = JSON.stringify({
          channelId: pageId,
          event: 'reaction_added',
          payload: {
            messageId,
            reaction: reactionWithUser,
          },
        });

        await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
          method: 'POST',
          headers: createSignedBroadcastHeaders(requestBody),
          body: requestBody,
        });
      } catch (error) {
        loggers.realtime.error('Failed to broadcast reaction:', error as Error);
      }
    }

    return NextResponse.json(reactionWithUser, { status: 201 });
  } catch (error) {
    // Unique constraint violation - user already reacted with this emoji
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json({ error: 'Already reacted with this emoji' }, { status: 409 });
    }
    throw error;
  }
}

/**
 * DELETE /api/channels/[pageId]/messages/[messageId]/reactions
 * Remove a reaction from a message
 */
export async function DELETE(req: Request, { params }: RouteParams) {
  const { pageId, messageId } = await params;

  const auth = await authenticateRequestWithOptions(req, AUTH_OPTIONS);
  if (isAuthError(auth)) return auth.error;
  const userId = auth.userId;

  // Check if user has view permission
  const canView = await canUserViewPage(userId, pageId);
  if (!canView) {
    return NextResponse.json({
      error: 'You need view permission to manage reactions',
    }, { status: 403 });
  }

  const { emoji } = await req.json();

  if (!emoji || typeof emoji !== 'string') {
    return NextResponse.json({ error: 'Emoji is required' }, { status: 400 });
  }

  // Delete the reaction (only the user's own reaction)
  const result = await db.delete(channelMessageReactions)
    .where(and(
      eq(channelMessageReactions.messageId, messageId),
      eq(channelMessageReactions.userId, userId),
      eq(channelMessageReactions.emoji, emoji)
    ))
    .returning();

  if (result.length === 0) {
    return NextResponse.json({ error: 'Reaction not found' }, { status: 404 });
  }

  // Broadcast reaction removal to channel
  if (process.env.INTERNAL_REALTIME_URL) {
    try {
      const requestBody = JSON.stringify({
        channelId: pageId,
        event: 'reaction_removed',
        payload: {
          messageId,
          emoji,
          userId,
        },
      });

      await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
        method: 'POST',
        headers: createSignedBroadcastHeaders(requestBody),
        body: requestBody,
      });
    } catch (error) {
      loggers.realtime.error('Failed to broadcast reaction removal:', error as Error);
    }
  }

  return NextResponse.json({ success: true });
}

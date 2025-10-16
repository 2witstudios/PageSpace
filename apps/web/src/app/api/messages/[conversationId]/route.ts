import { NextResponse } from 'next/server';
import { db, directMessages, dmConversations, eq, and, or, desc, lt } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';
import { createOrUpdateMessageNotification, isEmailVerified } from '@pagespace/lib';
import { createSignedBroadcastHeaders } from '@pagespace/lib/broadcast-auth';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: true };

// GET /api/messages/[conversationId] - Get messages in a conversation
export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { conversationId } = await context.params;
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 100);
    const before = searchParams.get('before'); // For pagination

    // Verify user is participant in conversation
    const [conversation] = await db
      .select()
      .from(dmConversations)
      .where(
        and(
          eq(dmConversations.id, conversationId),
          or(
            eq(dmConversations.participant1Id, userId),
            eq(dmConversations.participant2Id, userId)
          )
        )
      )
      .limit(1);

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Build query for messages
    const messagesQuery = before
      ? db
          .select()
          .from(directMessages)
          .where(
            and(
              eq(directMessages.conversationId, conversationId),
              lt(directMessages.createdAt, new Date(before))
            )
          )
          .orderBy(desc(directMessages.createdAt))
          .limit(limit)
      : db
          .select()
          .from(directMessages)
          .where(eq(directMessages.conversationId, conversationId))
          .orderBy(desc(directMessages.createdAt))
          .limit(limit);

    const messages = await messagesQuery;

    // Mark messages as read
    const otherUserId = conversation.participant1Id === userId
      ? conversation.participant2Id
      : conversation.participant1Id;

    await db
      .update(directMessages)
      .set({
        isRead: true,
        readAt: new Date(),
      })
      .where(
        and(
          eq(directMessages.conversationId, conversationId),
          eq(directMessages.senderId, otherUserId),
          eq(directMessages.isRead, false)
        )
      );

    // Update last read timestamp for conversation
    const updateField = conversation.participant1Id === userId
      ? { participant1LastRead: new Date() }
      : { participant2LastRead: new Date() };

    await db
      .update(dmConversations)
      .set(updateField)
      .where(eq(dmConversations.id, conversationId));

    // Reverse messages to show oldest first
    messages.reverse();

    return NextResponse.json({ messages });
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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Check email verification
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
    const body = await request.json();
    const { content } = body;

    if (!content || content.trim().length === 0) {
      return NextResponse.json(
        { error: 'Message content is required' },
        { status: 400 }
      );
    }

    // Verify user is participant in conversation
    const [conversation] = await db
      .select()
      .from(dmConversations)
      .where(
        and(
          eq(dmConversations.id, conversationId),
          or(
            eq(dmConversations.participant1Id, userId),
            eq(dmConversations.participant2Id, userId)
          )
        )
      )
      .limit(1);

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    // Create the message
    const [newMessage] = await db
      .insert(directMessages)
      .values({
        conversationId,
        senderId: userId,
        content,
      })
      .returning();

    // Update conversation's last message info
    const messagePreview = content.length > 100
      ? content.substring(0, 100) + '...'
      : content;

    await db
      .update(dmConversations)
      .set({
        lastMessageAt: new Date(),
        lastMessagePreview: messagePreview,
      })
      .where(eq(dmConversations.id, conversationId));

    // Send notification to recipient
    const recipientId = conversation.participant1Id === userId
      ? conversation.participant2Id
      : conversation.participant1Id;

    await createOrUpdateMessageNotification(
      recipientId,
      conversationId,
      messagePreview,
      userId
    );

    // Broadcast the new message to the DM room for realtime updates
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
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { conversationId } = await context.params;

    // Verify user is participant in conversation
    const [conversation] = await db
      .select()
      .from(dmConversations)
      .where(
        and(
          eq(dmConversations.id, conversationId),
          or(
            eq(dmConversations.participant1Id, userId),
            eq(dmConversations.participant2Id, userId)
          )
        )
      )
      .limit(1);

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const otherUserId = conversation.participant1Id === userId
      ? conversation.participant2Id
      : conversation.participant1Id;

    // Mark all unread messages from other user as read
    await db
      .update(directMessages)
      .set({
        isRead: true,
        readAt: new Date(),
      })
      .where(
        and(
          eq(directMessages.conversationId, conversationId),
          eq(directMessages.senderId, otherUserId),
          eq(directMessages.isRead, false)
        )
      );

    // Update last read timestamp for conversation
    const updateField = conversation.participant1Id === userId
      ? { participant1LastRead: new Date() }
      : { participant2LastRead: new Date() };

    await db
      .update(dmConversations)
      .set(updateField)
      .where(eq(dmConversations.id, conversationId));

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error marking messages as read:', error as Error);
    return NextResponse.json(
      { error: 'Failed to mark messages as read' },
      { status: 500 }
    );
  }
}

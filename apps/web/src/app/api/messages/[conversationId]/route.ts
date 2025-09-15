import { NextResponse } from 'next/server';
import { db, directMessages, dmConversations, eq, and, or, desc, lt } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logger-config';
import { createNotification } from '@pagespace/lib';

// GET /api/messages/[conversationId] - Get messages in a conversation
export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

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
            eq(dmConversations.participant1Id, user.id),
            eq(dmConversations.participant2Id, user.id)
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
    const otherUserId = conversation.participant1Id === user.id
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
    const updateField = conversation.participant1Id === user.id
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
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
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
            eq(dmConversations.participant1Id, user.id),
            eq(dmConversations.participant2Id, user.id)
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
        senderId: user.id,
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
    const recipientId = conversation.participant1Id === user.id
      ? conversation.participant2Id
      : conversation.participant1Id;

    await createNotification({
      userId: recipientId,
      type: 'NEW_DIRECT_MESSAGE',
      title: 'New Direct Message',
      message: messagePreview,
      metadata: {
        conversationId,
        messageId: newMessage.id,
      },
      triggeredByUserId: user.id,
    });

    // Broadcast the new message to the DM room for realtime updates
    if (process.env.INTERNAL_REALTIME_URL) {
      try {
        await fetch(`${process.env.INTERNAL_REALTIME_URL}/api/broadcast`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channelId: `dm:${conversationId}`,
            event: 'new_dm_message',
            payload: newMessage,
          }),
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
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { conversationId } = await context.params;

    // Verify user is participant in conversation
    const [conversation] = await db
      .select()
      .from(dmConversations)
      .where(
        and(
          eq(dmConversations.id, conversationId),
          or(
            eq(dmConversations.participant1Id, user.id),
            eq(dmConversations.participant2Id, user.id)
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

    const otherUserId = conversation.participant1Id === user.id
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
    const updateField = conversation.participant1Id === user.id
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

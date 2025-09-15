import { NextResponse } from 'next/server';
import { db, dmConversations, users, userProfiles, directMessages, connections, eq, and, or, desc, sql } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logger-config';

// GET /api/messages/conversations - Get user's DM conversations
export async function GET(request: Request) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get all conversations where user is a participant
    const conversations = await db
      .select({
        id: dmConversations.id,
        participant1Id: dmConversations.participant1Id,
        participant2Id: dmConversations.participant2Id,
        lastMessageAt: dmConversations.lastMessageAt,
        lastMessagePreview: dmConversations.lastMessagePreview,
        participant1LastRead: dmConversations.participant1LastRead,
        participant2LastRead: dmConversations.participant2LastRead,
        createdAt: dmConversations.createdAt,
      })
      .from(dmConversations)
      .where(
        or(
          eq(dmConversations.participant1Id, user.id),
          eq(dmConversations.participant2Id, user.id)
        )
      )
      .orderBy(desc(dmConversations.lastMessageAt));

    // Get user details and unread counts for each conversation
    const conversationDetails = await Promise.all(
      conversations.map(async (conv) => {
        const otherUserId = conv.participant1Id === user.id
          ? conv.participant2Id
          : conv.participant1Id;

        // Get other user's details
        const [otherUser] = await db
          .select({
            id: users.id,
            name: users.name,
            email: users.email,
            username: userProfiles.username,
            displayName: userProfiles.displayName,
            avatarUrl: userProfiles.avatarUrl,
          })
          .from(users)
          .leftJoin(userProfiles, eq(users.id, userProfiles.userId))
          .where(eq(users.id, otherUserId))
          .limit(1);

        // Get last read timestamp for current user
        const lastRead = conv.participant1Id === user.id
          ? conv.participant1LastRead
          : conv.participant2LastRead;

        // Count unread messages
        const [unreadCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(directMessages)
          .where(
            and(
              eq(directMessages.conversationId, conv.id),
              eq(directMessages.senderId, otherUserId),
              eq(directMessages.isRead, false)
            )
          );

        return {
          ...conv,
          otherUser,
          unreadCount: unreadCount?.count || 0,
          lastRead,
        };
      })
    );

    return NextResponse.json({ conversations: conversationDetails });
  } catch (error) {
    loggers.api.error('Error fetching conversations:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch conversations' },
      { status: 500 }
    );
  }
}

// POST /api/messages/conversations - Create a new conversation
export async function POST(request: Request) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { recipientId } = body;

    if (!recipientId) {
      return NextResponse.json(
        { error: 'Recipient ID is required' },
        { status: 400 }
      );
    }

    if (recipientId === user.id) {
      return NextResponse.json(
        { error: 'Cannot start conversation with yourself' },
        { status: 400 }
      );
    }

    // Check if users are connected
    const [connection] = await db
      .select()
      .from(connections)
      .where(
        and(
          or(
            and(
              eq(connections.user1Id, user.id),
              eq(connections.user2Id, recipientId)
            ),
            and(
              eq(connections.user1Id, recipientId),
              eq(connections.user2Id, user.id)
            )
          ),
          eq(connections.status, 'ACCEPTED')
        )
      )
      .limit(1);

    if (!connection) {
      return NextResponse.json(
        { error: 'You must be connected to start a conversation' },
        { status: 403 }
      );
    }

    // Ensure participant1Id < participant2Id for consistency
    const [participant1Id, participant2Id] = [user.id, recipientId].sort();

    // Check if conversation already exists
    const [existingConversation] = await db
      .select()
      .from(dmConversations)
      .where(
        and(
          eq(dmConversations.participant1Id, participant1Id),
          eq(dmConversations.participant2Id, participant2Id)
        )
      )
      .limit(1);

    if (existingConversation) {
      return NextResponse.json({ conversation: existingConversation });
    }

    // Create new conversation
    const [newConversation] = await db
      .insert(dmConversations)
      .values({
        participant1Id,
        participant2Id,
      })
      .returning();

    return NextResponse.json({ conversation: newConversation });
  } catch (error) {
    loggers.api.error('Error creating conversation:', error as Error);
    return NextResponse.json(
      { error: 'Failed to create conversation' },
      { status: 500 }
    );
  }
}
import { NextResponse } from 'next/server';
import { db, dmConversations, connections, eq, and, or, sql } from '@pagespace/db';
import { verifyAuth } from '@/lib/auth';
import { loggers } from '@pagespace/lib/logger-config';

// GET /api/messages/conversations - Get user's DM conversations with pagination
export async function GET(request: Request) {
  try {
    const user = await verifyAuth(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
    const cursor = searchParams.get('cursor'); // ISO timestamp
    const direction = searchParams.get('direction') || 'after'; // 'before' or 'after'

    // Single optimized query using CTE to eliminate N+1 problem
    const conversationDetails = await db.execute(sql`
      WITH conversation_data AS (
        SELECT
          c.id,
          c."participant1Id",
          c."participant2Id",
          c."lastMessageAt",
          c."lastMessagePreview",
          c."participant1LastRead",
          c."participant2LastRead",
          c."createdAt",
          CASE
            WHEN c."participant1Id" = ${user.id} THEN c."participant2Id"
            ELSE c."participant1Id"
          END as other_user_id,
          CASE
            WHEN c."participant1Id" = ${user.id} THEN c."participant1LastRead"
            ELSE c."participant2LastRead"
          END as last_read
        FROM dm_conversations c
        WHERE c."participant1Id" = ${user.id} OR c."participant2Id" = ${user.id}
        ${cursor ? (direction === 'before'
          ? sql`AND c."lastMessageAt" > ${cursor}`
          : sql`AND c."lastMessageAt" < ${cursor}`)
          : sql``}
        ORDER BY c."lastMessageAt" DESC NULLS LAST
        LIMIT ${limit}
      ),
      unread_counts AS (
        SELECT
          dm."conversationId",
          COUNT(*) as unread_count
        FROM direct_messages dm
        INNER JOIN conversation_data cd ON dm."conversationId" = cd.id
        WHERE dm."senderId" = cd.other_user_id
          AND dm."isRead" = false
        GROUP BY dm."conversationId"
      )
      SELECT
        cd.id,
        cd."participant1Id",
        cd."participant2Id",
        cd."lastMessageAt",
        cd."lastMessagePreview",
        cd."participant1LastRead",
        cd."participant2LastRead",
        cd."createdAt",
        cd.last_read,
        u.id as other_user_id,
        u.name as other_user_name,
        u.email as other_user_email,
        u.image as other_user_image,
        up.username as other_user_username,
        up."displayName" as other_user_display_name,
        up."avatarUrl" as other_user_avatar_url,
        COALESCE(uc.unread_count, 0) as unread_count
      FROM conversation_data cd
      LEFT JOIN users u ON u.id = cd.other_user_id
      LEFT JOIN user_profiles up ON up."userId" = cd.other_user_id
      LEFT JOIN unread_counts uc ON uc."conversationId" = cd.id
      ORDER BY cd."lastMessageAt" DESC NULLS LAST
    `);

    // Transform the raw results to match the expected format
    interface ConversationRow {
      id: string;
      participant1Id: string;
      participant2Id: string;
      lastMessageAt: string | null;
      lastMessagePreview: string | null;
      participant1LastRead: string | null;
      participant2LastRead: string | null;
      createdAt: string;
      last_read: string | null;
      other_user_id: string;
      other_user_name: string;
      other_user_email: string;
      other_user_image: string | null;
      other_user_username: string | null;
      other_user_display_name: string | null;
      other_user_avatar_url: string | null;
      unread_count: string;
    }

    const conversations = conversationDetails.rows.map((row) => {
      const typedRow = row as unknown as ConversationRow;
      return {
        id: typedRow.id,
        participant1Id: typedRow.participant1Id,
        participant2Id: typedRow.participant2Id,
        lastMessageAt: typedRow.lastMessageAt,
        lastMessagePreview: typedRow.lastMessagePreview,
        participant1LastRead: typedRow.participant1LastRead,
        participant2LastRead: typedRow.participant2LastRead,
        createdAt: typedRow.createdAt,
        lastRead: typedRow.last_read,
        otherUser: {
          id: typedRow.other_user_id,
          name: typedRow.other_user_name,
          email: typedRow.other_user_email,
          image: typedRow.other_user_image,
          username: typedRow.other_user_username,
          displayName: typedRow.other_user_display_name,
          avatarUrl: typedRow.other_user_avatar_url,
        },
        unreadCount: parseInt(typedRow.unread_count) || 0,
      };
    });

    // Determine if there are more conversations (for pagination)
    const hasMore = conversations.length === limit;
    const nextCursor = conversations.length > 0
      ? conversations[conversations.length - 1].lastMessageAt
      : null;

    return NextResponse.json({
      conversations,
      pagination: {
        hasMore,
        nextCursor,
        limit
      }
    });
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
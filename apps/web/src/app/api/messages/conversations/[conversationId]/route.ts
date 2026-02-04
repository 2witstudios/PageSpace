import { NextResponse } from 'next/server';
import { db, dmConversations, eq, and, or, sql } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

// GET /api/messages/conversations/[conversationId] - Get a single conversation's metadata
export async function GET(
  request: Request,
  context: { params: Promise<{ conversationId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { conversationId } = await context.params;

    // Fetch conversation with participant info
    const result = await db.execute(sql`
      SELECT
        c.id,
        c."participant1Id",
        c."participant2Id",
        c."lastMessageAt",
        c."lastMessagePreview",
        c."createdAt",
        CASE
          WHEN c."participant1Id" = ${userId} THEN c."participant2Id"
          ELSE c."participant1Id"
        END as other_user_id,
        u.id as user_id,
        u.name as user_name,
        u.email as user_email,
        u.image as user_image,
        up.username as user_username,
        up."displayName" as user_display_name,
        up."avatarUrl" as user_avatar_url
      FROM dm_conversations c
      LEFT JOIN users u ON u.id = CASE
        WHEN c."participant1Id" = ${userId} THEN c."participant2Id"
        ELSE c."participant1Id"
      END
      LEFT JOIN user_profiles up ON up."userId" = u.id
      WHERE c.id = ${conversationId}
        AND (c."participant1Id" = ${userId} OR c."participant2Id" = ${userId})
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    interface ConversationRow {
      id: string;
      participant1Id: string;
      participant2Id: string;
      lastMessageAt: string | null;
      lastMessagePreview: string | null;
      createdAt: string;
      other_user_id: string;
      user_id: string;
      user_name: string;
      user_email: string;
      user_image: string | null;
      user_username: string | null;
      user_display_name: string | null;
      user_avatar_url: string | null;
    }

    const row = result.rows[0] as unknown as ConversationRow;

    const conversation = {
      id: row.id,
      participant1Id: row.participant1Id,
      participant2Id: row.participant2Id,
      lastMessageAt: row.lastMessageAt,
      lastMessagePreview: row.lastMessagePreview,
      createdAt: row.createdAt,
      otherUser: {
        id: row.user_id,
        name: row.user_name,
        email: row.user_email,
        image: row.user_image,
        username: row.user_username,
        displayName: row.user_display_name,
        avatarUrl: row.user_avatar_url,
      },
    };

    return NextResponse.json({ conversation });
  } catch (error) {
    loggers.api.error('Error fetching conversation:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch conversation' },
      { status: 500 }
    );
  }
}

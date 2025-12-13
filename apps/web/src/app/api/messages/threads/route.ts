import { NextResponse } from 'next/server';
import { db, sql } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['jwt'] as const, requireCSRF: false };

// GET /api/messages/threads - Get user's unified message threads (DMs + channels)
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Fetch DMs and channels in parallel
    const [dmResults, channelResults] = await Promise.all([
      fetchDMConversations(userId),
      fetchChannelsWithLastMessage(userId),
    ]);

    return NextResponse.json({
      dms: dmResults,
      channels: channelResults,
    });
  } catch (error) {
    loggers.api.error('Error fetching message threads:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch message threads' },
      { status: 500 }
    );
  }
}

// Fetch DM conversations with last message and unread count
async function fetchDMConversations(userId: string) {
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
          WHEN c."participant1Id" = ${userId} THEN c."participant2Id"
          ELSE c."participant1Id"
        END as other_user_id,
        CASE
          WHEN c."participant1Id" = ${userId} THEN c."participant1LastRead"
          ELSE c."participant2LastRead"
        END as last_read
      FROM dm_conversations c
      WHERE c."participant1Id" = ${userId} OR c."participant2Id" = ${userId}
      ORDER BY c."lastMessageAt" DESC NULLS LAST
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

  return conversationDetails.rows.map((row) => {
    const typedRow = row as unknown as ConversationRow;
    return {
      id: typedRow.id,
      participant1Id: typedRow.participant1Id,
      participant2Id: typedRow.participant2Id,
      // Convert PostgreSQL timestamp strings to ISO 8601 for iOS compatibility
      lastMessageAt: typedRow.lastMessageAt ? new Date(typedRow.lastMessageAt).toISOString() : null,
      lastMessagePreview: typedRow.lastMessagePreview,
      participant1LastRead: typedRow.participant1LastRead ? new Date(typedRow.participant1LastRead).toISOString() : null,
      participant2LastRead: typedRow.participant2LastRead ? new Date(typedRow.participant2LastRead).toISOString() : null,
      createdAt: new Date(typedRow.createdAt).toISOString(),
      lastRead: typedRow.last_read ? new Date(typedRow.last_read).toISOString() : null,
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
}

// Fetch channels user has access to with their last message
async function fetchChannelsWithLastMessage(userId: string) {
  const channelDetails = await db.execute(sql`
    WITH user_channels AS (
      SELECT DISTINCT
        p.id,
        p.title,
        p."driveId",
        p."updatedAt",
        d.name as drive_name
      FROM pages p
      INNER JOIN drives d ON p."driveId" = d.id
      LEFT JOIN page_permissions pp ON p.id = pp."pageId"
      LEFT JOIN drive_members dm ON d.id = dm."driveId"
      WHERE p.type = 'CHANNEL'
        AND p."isTrashed" = false
        AND (
          d."ownerId" = ${userId}
          OR dm."userId" = ${userId}
          OR (pp."userId" = ${userId} AND pp."canView" = true)
        )
    ),
    latest_messages AS (
      SELECT DISTINCT ON (cm."pageId")
        cm."pageId",
        cm.content as last_message,
        cm."createdAt" as last_message_at
      FROM channel_messages cm
      INNER JOIN user_channels uc ON cm."pageId" = uc.id
      ORDER BY cm."pageId", cm."createdAt" DESC
    )
    SELECT
      uc.id,
      uc.title,
      uc."driveId",
      uc.drive_name,
      uc."updatedAt",
      lm.last_message,
      lm.last_message_at
    FROM user_channels uc
    LEFT JOIN latest_messages lm ON uc.id = lm."pageId"
    ORDER BY COALESCE(lm.last_message_at, uc."updatedAt") DESC
  `);

  interface ChannelRow {
    id: string;
    title: string;
    driveId: string;
    drive_name: string;
    updatedAt: string;
    last_message: string | null;
    last_message_at: string | null;
  }

  return channelDetails.rows.map((row) => {
    const typedRow = row as unknown as ChannelRow;
    return {
      id: typedRow.id,
      title: typedRow.title,
      driveId: typedRow.driveId,
      driveName: typedRow.drive_name,
      // Convert PostgreSQL timestamp strings to ISO 8601
      updatedAt: typedRow.updatedAt ? new Date(typedRow.updatedAt).toISOString() : new Date().toISOString(),
      lastMessage: typedRow.last_message,
      lastMessageAt: typedRow.last_message_at ? new Date(typedRow.last_message_at).toISOString() : null,
    };
  });
}

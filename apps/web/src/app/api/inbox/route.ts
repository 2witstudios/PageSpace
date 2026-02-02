import { NextResponse } from 'next/server';
import { db, sql } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

interface InboxItem {
  id: string;
  type: 'dm' | 'channel';
  name: string;
  avatarUrl: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageSender: string | null;
  unreadCount: number;
  driveId?: string;
  driveName?: string;
}

// Helper to convert raw PostgreSQL timestamp strings to ISO format
const toISOTimestamp = (timestamp: string | null): string | null => {
  if (!timestamp) return null;
  if (timestamp.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(timestamp)) {
    return timestamp;
  }
  return new Date(timestamp + 'Z').toISOString();
};

// GET /api/inbox - Get unified inbox (DMs + channels)
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS_READ);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
    const cursor = searchParams.get('cursor'); // ISO timestamp
    const driveId = searchParams.get('driveId'); // Optional: filter to specific drive

    const items: InboxItem[] = [];

    if (driveId) {
      // Drive-specific inbox: only channels from this drive
      const channelResults = await db.execute(sql`
        WITH drive_channels AS (
          SELECT
            p.id,
            p.title,
            p."driveId",
            d.name as drive_name
          FROM pages p
          INNER JOIN drives d ON d.id = p."driveId"
          INNER JOIN drive_members dm ON dm."driveId" = d.id AND dm."userId" = ${userId}
          WHERE p.type = 'CHANNEL'
            AND p."isTrashed" = false
            AND p."driveId" = ${driveId}
        ),
        channel_last_messages AS (
          SELECT DISTINCT ON (cm."pageId")
            cm."pageId",
            cm.content as last_message,
            cm."createdAt" as last_message_at,
            u.name as sender_name
          FROM channel_messages cm
          INNER JOIN drive_channels dc ON dc.id = cm."pageId"
          LEFT JOIN users u ON u.id = cm."userId"
          ORDER BY cm."pageId", cm."createdAt" DESC
        )
        SELECT
          dc.id,
          dc.title as name,
          dc."driveId" as drive_id,
          dc.drive_name,
          clm.last_message,
          clm.last_message_at,
          clm.sender_name
        FROM drive_channels dc
        LEFT JOIN channel_last_messages clm ON clm."pageId" = dc.id
        ${cursor ? sql`WHERE clm.last_message_at < ${cursor} OR clm.last_message_at IS NULL` : sql``}
        ORDER BY clm.last_message_at DESC NULLS LAST
        LIMIT ${limit}
      `);

      interface ChannelRow {
        id: string;
        name: string;
        drive_id: string;
        drive_name: string;
        last_message: string | null;
        last_message_at: string | null;
        sender_name: string | null;
      }

      for (const row of channelResults.rows) {
        const typedRow = row as unknown as ChannelRow;
        items.push({
          id: typedRow.id,
          type: 'channel',
          name: typedRow.name,
          avatarUrl: null,
          lastMessageAt: toISOTimestamp(typedRow.last_message_at),
          lastMessagePreview: typedRow.last_message ? typedRow.last_message.substring(0, 100) : null,
          lastMessageSender: typedRow.sender_name,
          unreadCount: 0, // Channel unread tracking not implemented yet
          driveId: typedRow.drive_id,
          driveName: typedRow.drive_name,
        });
      }
    } else {
      // Dashboard inbox: DMs + all channels from all drives

      // Fetch DM conversations
      const dmResults = await db.execute(sql`
        WITH dm_data AS (
          SELECT
            c.id,
            c."lastMessageAt",
            c."lastMessagePreview",
            CASE
              WHEN c."participant1Id" = ${userId} THEN c."participant2Id"
              ELSE c."participant1Id"
            END as other_user_id
          FROM dm_conversations c
          WHERE c."participant1Id" = ${userId} OR c."participant2Id" = ${userId}
        ),
        unread_counts AS (
          SELECT
            dm."conversationId",
            COUNT(*) as unread_count
          FROM direct_messages dm
          INNER JOIN dm_data dd ON dm."conversationId" = dd.id
          WHERE dm."senderId" = dd.other_user_id
            AND dm."isRead" = false
          GROUP BY dm."conversationId"
        )
        SELECT
          dd.id,
          dd."lastMessageAt" as last_message_at,
          dd."lastMessagePreview" as last_message,
          u.name as other_user_name,
          up."displayName" as other_user_display_name,
          up."avatarUrl" as other_user_avatar_url,
          COALESCE(uc.unread_count, 0) as unread_count
        FROM dm_data dd
        LEFT JOIN users u ON u.id = dd.other_user_id
        LEFT JOIN user_profiles up ON up."userId" = dd.other_user_id
        LEFT JOIN unread_counts uc ON uc."conversationId" = dd.id
        ORDER BY dd."lastMessageAt" DESC NULLS LAST
      `);

      interface DMRow {
        id: string;
        last_message_at: string | null;
        last_message: string | null;
        other_user_name: string;
        other_user_display_name: string | null;
        other_user_avatar_url: string | null;
        unread_count: string;
      }

      for (const row of dmResults.rows) {
        const typedRow = row as unknown as DMRow;
        items.push({
          id: typedRow.id,
          type: 'dm',
          name: typedRow.other_user_display_name || typedRow.other_user_name,
          avatarUrl: typedRow.other_user_avatar_url,
          lastMessageAt: toISOTimestamp(typedRow.last_message_at),
          lastMessagePreview: typedRow.last_message,
          lastMessageSender: null,
          unreadCount: parseInt(typedRow.unread_count) || 0,
        });
      }

      // Fetch channels from all drives user is member of
      const channelResults = await db.execute(sql`
        WITH user_channels AS (
          SELECT
            p.id,
            p.title,
            p."driveId",
            d.name as drive_name
          FROM pages p
          INNER JOIN drives d ON d.id = p."driveId"
          INNER JOIN drive_members dm ON dm."driveId" = d.id AND dm."userId" = ${userId}
          WHERE p.type = 'CHANNEL'
            AND p."isTrashed" = false
        ),
        channel_last_messages AS (
          SELECT DISTINCT ON (cm."pageId")
            cm."pageId",
            cm.content as last_message,
            cm."createdAt" as last_message_at,
            u.name as sender_name
          FROM channel_messages cm
          INNER JOIN user_channels uc ON uc.id = cm."pageId"
          LEFT JOIN users u ON u.id = cm."userId"
          ORDER BY cm."pageId", cm."createdAt" DESC
        )
        SELECT
          uc.id,
          uc.title as name,
          uc."driveId" as drive_id,
          uc.drive_name,
          clm.last_message,
          clm.last_message_at,
          clm.sender_name
        FROM user_channels uc
        LEFT JOIN channel_last_messages clm ON clm."pageId" = uc.id
        ORDER BY clm.last_message_at DESC NULLS LAST
      `);

      interface ChannelRow {
        id: string;
        name: string;
        drive_id: string;
        drive_name: string;
        last_message: string | null;
        last_message_at: string | null;
        sender_name: string | null;
      }

      for (const row of channelResults.rows) {
        const typedRow = row as unknown as ChannelRow;
        items.push({
          id: typedRow.id,
          type: 'channel',
          name: typedRow.name,
          avatarUrl: null,
          lastMessageAt: toISOTimestamp(typedRow.last_message_at),
          lastMessagePreview: typedRow.last_message ? typedRow.last_message.substring(0, 100) : null,
          lastMessageSender: typedRow.sender_name,
          unreadCount: 0,
          driveId: typedRow.drive_id,
          driveName: typedRow.drive_name,
        });
      }

      // Sort combined results by lastMessageAt
      items.sort((a, b) => {
        if (!a.lastMessageAt && !b.lastMessageAt) return 0;
        if (!a.lastMessageAt) return 1;
        if (!b.lastMessageAt) return -1;
        return new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime();
      });
    }

    // Apply cursor-based pagination for combined results
    let filteredItems = items;
    if (cursor && !driveId) {
      const cursorDate = new Date(cursor);
      filteredItems = items.filter(item => {
        if (!item.lastMessageAt) return true;
        return new Date(item.lastMessageAt) < cursorDate;
      });
    }

    // Apply limit
    const paginatedItems = filteredItems.slice(0, limit);

    // Determine pagination info
    const hasMore = filteredItems.length > limit;
    const nextCursor = paginatedItems.length > 0
      ? paginatedItems[paginatedItems.length - 1].lastMessageAt
      : null;

    return NextResponse.json({
      items: paginatedItems,
      pagination: {
        hasMore,
        nextCursor,
      },
    });
  } catch (error) {
    loggers.api.error('Error fetching inbox:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch inbox' },
      { status: 500 }
    );
  }
}

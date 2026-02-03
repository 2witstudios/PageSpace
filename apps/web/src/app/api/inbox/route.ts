import { NextResponse } from 'next/server';
import { db, sql } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers, canUserViewPage } from '@pagespace/lib/server';
import type { InboxItem, InboxResponse } from '@pagespace/lib';

const AUTH_OPTIONS_READ = { allow: ['session'] as const, requireCSRF: false };

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
    const cursor = searchParams.get('cursor'); // ISO timestamp or "id:<id>" for null timestamps
    const driveId = searchParams.get('driveId'); // Optional: filter to specific drive

    // Fetch one extra row to determine if there are more results
    const fetchLimit = limit + 1;

    const items: InboxItem[] = [];

    if (driveId) {
      // Parse cursor - can be ISO timestamp or "id:<channelId>" for null timestamps
      const isIdCursor = cursor !== null && cursor.startsWith('id:');
      const cursorId = isIdCursor ? cursor.slice(3) : null;
      const cursorTimestamp = !isIdCursor && cursor ? cursor : null;

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
          LEFT JOIN drive_members dm ON dm."driveId" = d.id AND dm."userId" = ${userId}
          WHERE p.type = 'CHANNEL'
            AND p."isTrashed" = false
            AND p."driveId" = ${driveId}
            AND (d."ownerId" = ${userId} OR dm."userId" IS NOT NULL)
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
        ),
        channel_unread AS (
          SELECT cm."pageId", COUNT(*) as unread_count
          FROM channel_messages cm
          LEFT JOIN channel_read_status crs
            ON crs."channelId" = cm."pageId" AND crs."userId" = ${userId}
          WHERE cm."createdAt" > COALESCE(crs."lastReadAt", '1970-01-01'::timestamp)
            AND cm."userId" != ${userId}
          GROUP BY cm."pageId"
        )
        SELECT
          dc.id,
          dc.title as name,
          dc."driveId" as drive_id,
          dc.drive_name,
          clm.last_message,
          clm.last_message_at,
          clm.sender_name,
          COALESCE(cu.unread_count, 0) as unread_count
        FROM drive_channels dc
        LEFT JOIN channel_last_messages clm ON clm."pageId" = dc.id
        LEFT JOIN channel_unread cu ON cu."pageId" = dc.id
        ${cursorTimestamp
          ? sql`WHERE (clm.last_message_at < ${cursorTimestamp} OR clm.last_message_at IS NULL)`
          : cursorId
            ? sql`WHERE clm.last_message_at IS NULL AND dc.id < ${cursorId}`
            : sql``}
        ORDER BY clm.last_message_at DESC NULLS LAST, dc.id DESC
        LIMIT ${fetchLimit}
      `);

      interface ChannelRow {
        id: string;
        name: string;
        drive_id: string;
        drive_name: string;
        last_message: string | null;
        last_message_at: string | null;
        sender_name: string | null;
        unread_count: string;
      }

      for (const row of channelResults.rows) {
        const typedRow = row as unknown as ChannelRow;

        // Check page-level permission before including in results
        const canView = await canUserViewPage(userId, typedRow.id);
        if (!canView) continue;

        items.push({
          id: typedRow.id,
          type: 'channel',
          name: typedRow.name,
          avatarUrl: null,
          lastMessageAt: toISOTimestamp(typedRow.last_message_at),
          lastMessagePreview: typedRow.last_message ? typedRow.last_message.substring(0, 100) : null,
          lastMessageSender: typedRow.sender_name,
          unreadCount: parseInt(typedRow.unread_count) || 0,
          driveId: typedRow.drive_id,
          driveName: typedRow.drive_name,
        });
      }

      // Determine pagination for drive-specific query
      const hasMore = items.length > limit;
      const paginatedItems = items.slice(0, limit);
      const lastItem = paginatedItems[paginatedItems.length - 1];
      const nextCursor = lastItem
        ? lastItem.lastMessageAt || `id:${lastItem.id}`
        : null;

      return NextResponse.json({
        items: paginatedItems,
        pagination: {
          hasMore,
          nextCursor,
        },
      } satisfies InboxResponse);
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
        LIMIT ${fetchLimit}
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

      // Fetch channels from all drives user is member of or owns
      const channelResults = await db.execute(sql`
        WITH user_channels AS (
          SELECT
            p.id,
            p.title,
            p."driveId",
            d.name as drive_name
          FROM pages p
          INNER JOIN drives d ON d.id = p."driveId"
          LEFT JOIN drive_members dm ON dm."driveId" = d.id AND dm."userId" = ${userId}
          WHERE p.type = 'CHANNEL'
            AND p."isTrashed" = false
            AND (d."ownerId" = ${userId} OR dm."userId" IS NOT NULL)
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
        ),
        channel_unread AS (
          SELECT cm."pageId", COUNT(*) as unread_count
          FROM channel_messages cm
          LEFT JOIN channel_read_status crs
            ON crs."channelId" = cm."pageId" AND crs."userId" = ${userId}
          WHERE cm."createdAt" > COALESCE(crs."lastReadAt", '1970-01-01'::timestamp)
            AND cm."userId" != ${userId}
          GROUP BY cm."pageId"
        )
        SELECT
          uc.id,
          uc.title as name,
          uc."driveId" as drive_id,
          uc.drive_name,
          clm.last_message,
          clm.last_message_at,
          clm.sender_name,
          COALESCE(cu.unread_count, 0) as unread_count
        FROM user_channels uc
        LEFT JOIN channel_last_messages clm ON clm."pageId" = uc.id
        LEFT JOIN channel_unread cu ON cu."pageId" = uc.id
        ORDER BY clm.last_message_at DESC NULLS LAST
        LIMIT ${fetchLimit}
      `);

      interface ChannelRow {
        id: string;
        name: string;
        drive_id: string;
        drive_name: string;
        last_message: string | null;
        last_message_at: string | null;
        sender_name: string | null;
        unread_count: string;
      }

      for (const row of channelResults.rows) {
        const typedRow = row as unknown as ChannelRow;

        // Check page-level permission before including in results
        const canView = await canUserViewPage(userId, typedRow.id);
        if (!canView) continue;

        items.push({
          id: typedRow.id,
          type: 'channel',
          name: typedRow.name,
          avatarUrl: null,
          lastMessageAt: toISOTimestamp(typedRow.last_message_at),
          lastMessagePreview: typedRow.last_message ? typedRow.last_message.substring(0, 100) : null,
          lastMessageSender: typedRow.sender_name,
          unreadCount: parseInt(typedRow.unread_count) || 0,
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
    // Parse cursor - can be ISO timestamp or "id:<itemId>" for null timestamps
    const isIdCursor = cursor !== null && cursor.startsWith('id:');
    const cursorId = isIdCursor ? cursor.slice(3) : null;
    const cursorTimestamp = !isIdCursor && cursor ? cursor : null;

    let filteredItems = items;
    if (cursorTimestamp) {
      const cursorDate = new Date(cursorTimestamp);
      filteredItems = items.filter(item => {
        if (!item.lastMessageAt) return true; // Include items with no timestamp
        return new Date(item.lastMessageAt) < cursorDate;
      });
    } else if (cursorId) {
      // For id-based cursor, skip items until we find the cursor id, then skip that item too
      const cursorIndex = items.findIndex(item => item.id === cursorId);
      if (cursorIndex >= 0) {
        filteredItems = items.slice(cursorIndex + 1);
      }
    }

    // Apply limit (we fetch extra to check for more, but only for drive queries)
    const paginatedItems = filteredItems.slice(0, limit);

    // Determine pagination info
    const hasMore = filteredItems.length > limit;
    const lastItem = paginatedItems[paginatedItems.length - 1];
    const nextCursor = lastItem
      ? lastItem.lastMessageAt || `id:${lastItem.id}`
      : null;

    return NextResponse.json({
      items: paginatedItems,
      pagination: {
        hasMore,
        nextCursor,
      },
    } satisfies InboxResponse);
  } catch (error) {
    loggers.api.error('Error fetching inbox:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch inbox' },
      { status: 500 }
    );
  }
}

import { NextResponse } from 'next/server';
import { db, sql } from '@pagespace/db';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { loggers } from '@pagespace/lib/server';

const AUTH_OPTIONS = { allow: ['session'] as const, requireCSRF: false };

// GET /api/inbox/channels - Get user's accessible channels with recent activity
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const userId = auth.userId;

    // Query channels the user has access to via:
    // 1. Drives they own
    // 2. Drives they are members of
    const channelData = await db.execute(sql`
      WITH accessible_drives AS (
        -- Drives owned by user
        SELECT d.id as drive_id, d.name as drive_name
        FROM drives d
        WHERE d."ownerId" = ${userId}
          AND d."isTrashed" = false

        UNION

        -- Drives where user is a member
        SELECT d.id as drive_id, d.name as drive_name
        FROM drives d
        INNER JOIN drive_members dm ON dm."driveId" = d.id
        WHERE dm."userId" = ${userId}
          AND d."isTrashed" = false
      ),
      channel_activity AS (
        SELECT
          cm."pageId",
          MAX(cm."createdAt") as last_message_at,
          COUNT(*) as message_count
        FROM channel_messages cm
        GROUP BY cm."pageId"
      )
      SELECT
        p.id,
        p.title,
        p."driveId",
        ad.drive_name,
        p."createdAt",
        p."updatedAt",
        COALESCE(ca.last_message_at, p."createdAt") as last_activity,
        COALESCE(ca.message_count, 0) as message_count
      FROM pages p
      INNER JOIN accessible_drives ad ON p."driveId" = ad.drive_id
      LEFT JOIN channel_activity ca ON ca."pageId" = p.id
      WHERE p.type = 'CHANNEL'
        AND p."isTrashed" = false
      ORDER BY COALESCE(ca.last_message_at, p."createdAt") DESC
      LIMIT 50
    `);

    interface ChannelRow {
      id: string;
      title: string;
      driveId: string;
      drive_name: string;
      createdAt: string;
      updatedAt: string;
      last_activity: string;
      message_count: string;
    }

    const channels = channelData.rows.map((row) => {
      const typedRow = row as unknown as ChannelRow;
      return {
        id: typedRow.id,
        title: typedRow.title,
        driveId: typedRow.driveId,
        driveName: typedRow.drive_name,
        createdAt: typedRow.createdAt,
        updatedAt: typedRow.updatedAt,
        lastActivity: typedRow.last_activity,
        messageCount: parseInt(typedRow.message_count) || 0,
      };
    });

    return NextResponse.json({ channels });
  } catch (error) {
    loggers.api.error('Error fetching channels:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch channels' },
      { status: 500 }
    );
  }
}

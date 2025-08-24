import { NextResponse } from 'next/server';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { drives, db, eq, and, mcpTokens, isNull } from '@pagespace/db';
import { loggers } from '@pagespace/lib/logger-config';
import { broadcastDriveEvent, createDriveEventPayload } from '@/lib/socket-utils';

// Validate MCP token and return user ID
async function validateMCPToken(token: string): Promise<string | null> {
  try {
    if (!token || !token.startsWith('mcp_')) {
      return null;
    }

    const tokenData = await db.query.mcpTokens.findFirst({
      where: and(
        eq(mcpTokens.token, token),
        isNull(mcpTokens.revokedAt)
      ),
    });

    if (!tokenData) {
      return null;
    }

    await db
      .update(mcpTokens)
      .set({ lastUsed: new Date() })
      .where(eq(mcpTokens.id, tokenData.id));

    return tokenData.userId;
  } catch (error) {
    loggers.api.error('MCP token validation error:', error as Error);
    return null;
  }
}

// Get user ID from either cookie or MCP token
async function getUserId(req: Request): Promise<string | null> {
  // Check for Bearer token (MCP authentication) first
  const authHeader = req.headers.get('authorization');
  if (authHeader?.startsWith('Bearer mcp_')) {
    const mcpToken = authHeader.substring(7); // Remove "Bearer " prefix
    const userId = await validateMCPToken(mcpToken);
    if (userId) {
      return userId;
    }
  }

  // Fallback to cookie-based authentication
  const cookieHeader = req.headers.get('cookie');
  if (!cookieHeader) {
    return null;
  }

  const cookies = parse(cookieHeader);
  const authToken = cookies['accessToken'];
  if (!authToken) {
    return null;
  }

  const decoded = await decodeToken(authToken);
  if (!decoded || !decoded.userId) {
    return null;
  }

  return decoded.userId;
}

/**
 * POST /api/drives/[driveId]/restore
 * Restore drive from trash
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const userId = await getUserId(request);
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Find the drive and verify ownership
    const drive = await db.query.drives.findFirst({
      where: and(
        eq(drives.id, driveId),
        eq(drives.ownerId, userId)
      ),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found or access denied' }, { status: 404 });
    }

    if (!drive.isTrashed) {
      return NextResponse.json({ error: 'Drive is not in trash' }, { status: 400 });
    }

    // Restore drive from trash
    await db
      .update(drives)
      .set({
        isTrashed: false,
        trashedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(drives.id, drive.id));

    // Broadcast drive update event (restored from trash)
    await broadcastDriveEvent(
      createDriveEventPayload(drive.id, 'updated', {
        name: drive.name,
        slug: drive.slug,
      })
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    loggers.api.error('Error restoring drive:', error as Error);
    return NextResponse.json({ error: 'Failed to restore drive' }, { status: 500 });
  }
}
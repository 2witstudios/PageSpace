import { NextResponse } from 'next/server';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { drives, db, eq, and, mcpTokens, isNull, driveMembers } from '@pagespace/db';
import { z } from 'zod';
import { loggers } from '@pagespace/lib/logger-config';

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

const patchSchema = z.object({
  name: z.string().optional(),
  aiProvider: z.string().optional(),
  aiModel: z.string().optional(),
});

/**
 * GET /api/drives/[driveId]
 * Get drive details including AI model preferences
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const userId = await getUserId(request);
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // First try to get the drive
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Check if user has access (owner or member)
    const isOwned = drive.ownerId === userId;
    let isMember = false;
    
    if (!isOwned) {
      const membership = await db.query.driveMembers.findFirst({
        where: and(
          eq(driveMembers.driveId, drive.id),
          eq(driveMembers.userId, userId)
        ),
      });

      if (!membership) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
      
      isMember = true;
    }

    // Return drive with ownership/membership flags
    return NextResponse.json({
      ...drive,
      isOwned,
      isMember
    });
  } catch (error) {
    loggers.api.error('Error fetching drive:', error as Error);
    return NextResponse.json({ error: 'Failed to fetch drive' }, { status: 500 });
  }
}

/**
 * PATCH /api/drives/[driveId]
 * Update drive settings including AI model preferences
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const { driveId } = await context.params;
    const userId = await getUserId(request);
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const validatedBody = patchSchema.parse(body);

    // Find the drive
    const drive = await db.query.drives.findFirst({
      where: and(
        eq(drives.id, driveId),
        eq(drives.ownerId, userId)
      ),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Update the drive
    await db
      .update(drives)
      .set({
        ...validatedBody,
        updatedAt: new Date(),
      })
      .where(eq(drives.id, drive.id));

    // Fetch updated drive
    const updatedDrive = await db.query.drives.findFirst({
      where: eq(drives.id, drive.id),
    });

    return NextResponse.json(updatedDrive);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Invalid request body', details: error.issues }, { status: 400 });
    }
    loggers.api.error('Error updating drive:', error as Error);
    return NextResponse.json({ error: 'Failed to update drive' }, { status: 500 });
  }
}
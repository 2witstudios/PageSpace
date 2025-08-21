import { NextResponse } from 'next/server';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { drives, pages, users, db, and, eq, desc, mcpTokens, isNull } from '@pagespace/db';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { loggers } from '@pagespace/lib/logger-config';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';

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

  // Fall back to cookie authentication
  const cookieHeader = req.headers.get('cookie');
  const cookies = parse(cookieHeader || '');
  const accessToken = cookies.accessToken;

  if (!accessToken) {
    return null;
  }

  const decoded = await decodeToken(accessToken);
  return decoded ? decoded.userId : null;
}

export async function POST(request: Request) {
  const userId = await getUserId(request);

  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const { title, type, parentId, driveId, content } = await request.json();

    if (!title || !type || !driveId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const drive = await db.query.drives.findFirst({
      where: and(eq(drives.id, driveId), eq(drives.ownerId, userId)),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    // Get the highest position for the current parent
    const lastPage = await db.query.pages.findFirst({
      where: and(eq(pages.parentId, parentId), eq(pages.driveId, drive.id)),
      orderBy: [desc(pages.position)],
    });

    const newPosition = (lastPage?.position || 0) + 1;

    // Get user's current AI provider settings for AI_CHAT pages
    let aiProvider = null;
    let aiModel = null;
    
    if (type === 'AI_CHAT') {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: {
          currentAiProvider: true,
          currentAiModel: true,
        },
      });
      
      if (user) {
        aiProvider = user.currentAiProvider || 'pagespace';
        aiModel = user.currentAiModel || 'qwen/qwen3-coder:free';
      }
    }

    const newPage = await db.transaction(async (tx) => {
      const [page] = await tx.insert(pages).values({
        title,
        type: type,
        parentId,
        driveId: drive.id,
        content: content || '',
        position: newPosition,
        aiProvider,
        aiModel,
        updatedAt: new Date(),
      }).returning();

      // AI_CHAT pages now use the new AI SDK v5 system
      // No need for separate aiChats table
      
      return page;
    });

    // Broadcast page creation event
    await broadcastPageEvent(
      createPageEventPayload(driveId, newPage.id, 'created', {
        parentId,
        title,
        type
      })
    );

    // Track page creation
    trackPageOperation(userId, 'create', newPage.id, { 
      title, 
      type, 
      driveId: drive.id,
      parentId 
    });

    return NextResponse.json(newPage, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating page:', error as Error);
    return NextResponse.json({ error: 'Failed to create page' }, { status: 500 });
  }
}
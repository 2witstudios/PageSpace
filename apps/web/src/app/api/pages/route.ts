import { NextResponse } from 'next/server';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { drives, pages, users, db, and, eq, desc, mcpTokens, isNull } from '@pagespace/db';
import { validatePageCreation, validateAIChatTools, getDefaultContent, PageType as PageTypeEnum, isAIChatPage } from '@pagespace/lib';
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
    const { title, type, parentId, driveId, content, systemPrompt, enabledTools, aiProvider, aiModel } = await request.json();

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

    // Use centralized validation
    const validation = validatePageCreation(type as PageTypeEnum, {
      title,
      systemPrompt,
      enabledTools,
      aiProvider,
      aiModel,
    });

    if (!validation.valid) {
      return NextResponse.json({ 
        error: validation.errors.join('. ') 
      }, { status: 400 });
    }

    // Additional tool validation for AI_CHAT pages
    if (isAIChatPage(type) && enabledTools && enabledTools.length > 0) {
      const { pageSpaceTools } = await import('@/lib/ai/ai-tools');
      const availableToolNames = Object.keys(pageSpaceTools);
      const toolValidation = validateAIChatTools(enabledTools, availableToolNames);
      if (!toolValidation.valid) {
        return NextResponse.json({ 
          error: toolValidation.errors.join('. ') 
        }, { status: 400 });
      }
    }

    // Get user's current AI provider settings for AI_CHAT pages
    let defaultAiProvider = null;
    let defaultAiModel = null;
    
    if (isAIChatPage(type)) {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: {
          currentAiProvider: true,
          currentAiModel: true,
        },
      });
      
      if (user) {
        defaultAiProvider = user.currentAiProvider || 'pagespace';
        defaultAiModel = user.currentAiModel || 'qwen/qwen3-coder:free';
      }
    }

    const newPage = await db.transaction(async (tx) => {
      // Prepare page data with proper typing that matches database schema
      interface APIPageInsertData {
        title: string;
        type: 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS';
        parentId: string | null;
        driveId: string;
        content: string;
        position: number;
        updatedAt: Date;
        aiProvider?: string | null;
        aiModel?: string | null;
        systemPrompt?: string | null;
        enabledTools?: string[] | null;
      }

      const pageData: APIPageInsertData = {
        title,
        type: type as 'FOLDER' | 'DOCUMENT' | 'CHANNEL' | 'AI_CHAT' | 'CANVAS',
        parentId,
        driveId: drive.id,
        content: content || getDefaultContent(type as PageTypeEnum),
        position: newPosition,
        updatedAt: new Date(),
      };

      // Add AI configuration for AI_CHAT pages
      if (isAIChatPage(type)) {
        pageData.aiProvider = aiProvider || defaultAiProvider;
        pageData.aiModel = aiModel || defaultAiModel;
        
        // Add agent-specific configuration if provided
        if (systemPrompt) {
          pageData.systemPrompt = systemPrompt;
        }
        if (enabledTools && enabledTools.length > 0) {
          pageData.enabledTools = enabledTools;
        }
      }

      const [page] = await tx.insert(pages).values(pageData).returning();

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
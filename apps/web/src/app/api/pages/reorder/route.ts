import { NextResponse } from 'next/server';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { pages, drives, db, and, eq, mcpTokens, isNull } from '@pagespace/db';
import { z } from 'zod/v4';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';
import { loggers } from '@pagespace/lib/logger-config';

const reorderSchema = z.object({
  pageId: z.string(),
  newParentId: z.string().nullable(),
  newPosition: z.number(),
});

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

export async function PATCH(request: Request) {
  const userId = await getUserId(request);

  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const body = await request.json();
    const { pageId, newParentId, newPosition } = reorderSchema.parse(body);

    let driveId: string | null = null;
    let pageTitle: string | null = null;

    await db.transaction(async (tx) => {
      // 1. Verify user owns the page being moved and get drive info
      const pageToMoveQuery = await tx.select({ 
        driveId: pages.driveId,
        title: pages.title
      })
        .from(pages)
        .leftJoin(drives, eq(pages.driveId, drives.id))
        .where(and(eq(pages.id, pageId), eq(drives.ownerId, userId)))
        .limit(1);
      
      const pageToMove = pageToMoveQuery[0];

      if (!pageToMove) {
        throw new Error("Page not found or user does not have access.");
      }

      driveId = pageToMove.driveId;
      pageTitle = pageToMove.title;

      // 2. If moving to a new parent, verify user owns the parent and it's in the same drive
      if (newParentId) {
        const parentPageQuery = await tx.select({ driveId: pages.driveId })
          .from(pages)
          .leftJoin(drives, eq(pages.driveId, drives.id))
          .where(and(eq(pages.id, newParentId), eq(drives.ownerId, userId)))
          .limit(1);
        
        const parentPage = parentPageQuery[0];

        if (!parentPage) {
          throw new Error("Parent page not found or user does not have access.");
        }

        if (parentPage.driveId !== pageToMove.driveId) {
          throw new Error("Cannot move pages between different drives.");
        }
      }

      // 3. Perform the update
      await tx.update(pages).set({
        parentId: newParentId,
        position: newPosition,
      }).where(eq(pages.id, pageId));
    });

    // Broadcast page move event
    if (driveId) {
      await broadcastPageEvent(
        createPageEventPayload(driveId, pageId, 'moved', {
          parentId: newParentId,
          title: pageTitle || undefined
        })
      );
    }

    return NextResponse.json({ message: 'Page reordered successfully' });
  } catch (error) {
    loggers.api.error('Error reordering page:', error as Error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to reorder page';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
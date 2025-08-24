import { NextResponse } from 'next/server';
import { pages, db, and, eq, mcpTokens, isNull } from '@pagespace/db';
import { decodeToken } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { loggers } from '@pagespace/lib/logger-config';
import { trackPageOperation } from '@pagespace/lib/activity-tracker';
import { broadcastPageEvent, createPageEventPayload } from '@/lib/socket-utils';

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

async function recursivelyRestore(pageId: string, tx: typeof db) {
    await tx.update(pages).set({ isTrashed: false, trashedAt: null }).where(eq(pages.id, pageId));

    const children = await tx.select({ id: pages.id }).from(pages).where(and(eq(pages.parentId, pageId), eq(pages.isTrashed, true)));

    for (const child of children) {
        await recursivelyRestore(child.id, tx);
    }

    const orphanedChildren = await tx.select({ id: pages.id }).from(pages).where(eq(pages.originalParentId, pageId));

    for (const child of orphanedChildren) {
        await tx.update(pages).set({ parentId: pageId, originalParentId: null }).where(eq(pages.id, child.id));
    }
}

export async function POST(req: Request, { params }: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await params;
  const userId = await getUserId(req);

  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const page = await db.query.pages.findFirst({ 
      where: eq(pages.id, pageId),
      with: {
        drive: {
          columns: { id: true }
        }
      }
    });
    if (!page || !page.isTrashed) {
      return NextResponse.json({ error: 'Page is not in trash' }, { status: 400 });
    }

    await db.transaction(async (tx) => {
      await recursivelyRestore(pageId, tx);
    });

    // Broadcast page restoration event
    if (page.drive?.id) {
      await broadcastPageEvent(
        createPageEventPayload(page.drive.id, pageId, 'restored', {
          title: page.title,
          parentId: page.parentId,
          type: page.type
        })
      );
    }

    // Track page restore
    trackPageOperation(userId, 'restore', pageId, {
      pageTitle: page.title,
      pageType: page.type
    });

    return NextResponse.json({ message: 'Page restored successfully.' });
  } catch (error) {
    loggers.api.error('Error restoring page:', error as Error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to restore page';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
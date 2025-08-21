import { NextResponse } from 'next/server';
import { drives, pages, mcpTokens, isNull } from '@pagespace/db';
import { db, and, eq, asc } from '@pagespace/db';
import { decodeToken, buildTree } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { loggers } from '@pagespace/lib/logger-config';

interface DriveParams {
  driveId: string;
}

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

export async function GET(request: Request, context: { params: Promise<DriveParams> }) {
    const userId = await getUserId(request);

    if (!userId) {
        return new NextResponse("Unauthorized", { status: 401 });
    }

    const { driveId } = await context.params;

    try {
        const drive = await db.query.drives.findFirst({
            where: and(
                eq(drives.id, driveId),
                eq(drives.ownerId, userId)
            ),
        });

        if (!drive) {
            return NextResponse.json({ error: 'Drive not found or you do not have permission to view its trash.' }, { status: 404 });
        }

        const trashedPages = await db.query.pages.findMany({
            where: and(
                eq(pages.driveId, drive.id),
                eq(pages.isTrashed, true)
            ),
            with: {
                children: true,
            },
            orderBy: [asc(pages.position)],
        });

        // We will build a tree from the flat list of trashed pages
        const tree = buildTree(trashedPages);

        return NextResponse.json(tree);
    } catch (error) {
        loggers.api.error('Failed to fetch trashed pages:', error as Error);
        return NextResponse.json({ error: 'Failed to fetch trashed pages' }, { status: 500 });
    }
}
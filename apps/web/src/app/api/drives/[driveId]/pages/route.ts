import { NextRequest, NextResponse } from 'next/server';
import { decodeToken, buildTree } from '@pagespace/lib/server';
import { parse } from 'cookie';
import { pages, drives, pageType, pagePermissions, db, and, eq, inArray, asc, sql, mcpTokens, isNull } from '@pagespace/db';
import { z } from 'zod/v4';
import { loggers } from '@pagespace/lib/logger-config';

// Validate MCP token and return user ID
async function validateMCPToken(token: string): Promise<string | null> {
  try {
    if (!token || !token.startsWith('mcp_')) {
      return null;
    }

    // Find the token in database (checking for non-revoked tokens)
    const tokenData = await db.query.mcpTokens.findFirst({
      where: and(
        eq(mcpTokens.token, token),
        isNull(mcpTokens.revokedAt)
      ),
    });

    if (!tokenData) {
      return null;
    }

    // Update last used timestamp
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
async function getUserId(req: NextRequest): Promise<string | null> {
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

async function getPermittedPages(driveId: string, userId: string) {
  // Check if user is a drive member - currently unused but will be needed for member-level permissions
  // const membership = await db.query.driveMembers.findFirst({
  //   where: and(
  //     eq(driveMembers.driveId, driveId),
  //     eq(driveMembers.userId, userId)
  //   )
  // });

  // Get pages user has explicit permissions for
  const permittedPageIdsQuery = await db.selectDistinct({ id: pages.id })
    .from(pages)
    .leftJoin(pagePermissions, eq(pages.id, pagePermissions.pageId))
    .where(and(
      eq(pages.driveId, driveId),
      eq(pages.isTrashed, false),
      eq(pagePermissions.userId, userId),
      eq(pagePermissions.canView, true)
    ));
  const permittedPageIds = permittedPageIdsQuery.map(p => p.id);

  if (permittedPageIds.length === 0) {
    return [];
  }

  // If user has any permissions, also get ancestor pages for tree structure
  let ancestorIds: string[] = [];
  if (permittedPageIds.length > 0) {
    const ancestorIdsQuery = await db.execute(sql`
      WITH RECURSIVE ancestors AS (
        SELECT id, "parentId"
        FROM pages
        WHERE id IN ${permittedPageIds}
        UNION ALL
        SELECT p.id, p."parentId"
        FROM pages p
        JOIN ancestors a ON p.id = a."parentId"
      )
      SELECT id FROM ancestors;
    `);
    ancestorIds = (ancestorIdsQuery.rows as { id: string }[]).map(r => r.id);
  }

  const allVisiblePageIds = [...new Set([...permittedPageIds, ...ancestorIds])];

  return db.query.pages.findMany({
    where: and(
      inArray(pages.id, allVisiblePageIds),
      eq(pages.isTrashed, false)
    ),
    orderBy: [asc(pages.position)],
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ driveId: string }> }
) {
  const userId = await getUserId(request);

  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const { driveId } = await context.params;

    // Find drive by id, but don't scope to owner yet
    const drive = await db.query.drives.findFirst({
      where: eq(drives.id, driveId),
    });

    if (!drive) {
      return NextResponse.json({ error: 'Drive not found' }, { status: 404 });
    }

    let pageResults;

    // If user owns the drive, fetch all pages
    if (drive.ownerId === userId) {
      pageResults = await db.query.pages.findMany({
        where: and(
          eq(pages.driveId, drive.id),
          eq(pages.isTrashed, false)
        ),
        orderBy: [asc(pages.position)],
      });
    } else {
      // If user does not own the drive, fetch only permitted pages and their ancestors
      pageResults = await getPermittedPages(drive.id, userId);
    }

    const pageTree = buildTree(pageResults);
    return NextResponse.json(pageTree);
  } catch (error) {
    loggers.api.error('Error fetching pages:', error as Error);
    return NextResponse.json(
      { error: 'Failed to fetch pages' },
      { status: 500 }
    );
  }
}

const createPageSchema = z.object({
  title: z.string().min(1),
  type: z.enum(pageType.enumValues),
  parentId: z.string().nullable(),
  position: z.number(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ driveId: string }> }
) {
  const userId = await getUserId(request);

  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const { driveId } = await context.params;
    const body = await request.json();
    const { title, type, parentId, position } = createPageSchema.parse(body);

    const newPage = await db.transaction(async (tx) => {
      const drive = await tx.query.drives.findFirst({
        where: and(eq(drives.ownerId, userId), eq(drives.id, driveId)),
      });

      if (!drive) {
        throw new Error('Drive not found or access denied.');
      }

      if (parentId) {
        const parentPage = await tx.query.pages.findFirst({
          where: and(eq(pages.id, parentId), eq(pages.driveId, drive.id)),
        });
        if (!parentPage) {
          throw new Error('Parent page not found in the specified drive.');
        }
      }

      const [createdPage] = await tx.insert(pages).values({
        title,
        type,
        position,
        driveId: drive.id,
        parentId,
        updatedAt: new Date(),
      }).returning();

      // AI_CHAT pages now use the new AI SDK v5 system
      // No need for separate aiChats table - messages are stored in chatMessages

      return createdPage;
    });

    return NextResponse.json(newPage, { status: 201 });
  } catch (error) {
    loggers.api.error('Error creating page:', error as Error);
    const errorMessage = error instanceof Error ? error.message : 'Failed to create page';
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };
import { db, pages, drives, eq, and, sql } from '@pagespace/db';
import { getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * GET /api/drives/[driveId]/search/regex
 * Search page content using regular expression patterns
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ driveId: string }> }
) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { driveId } = await context.params;
    const { searchParams } = new URL(request.url);
    const pattern = searchParams.get('pattern');
    const searchIn = searchParams.get('searchIn') || 'content';
    const maxResults = Math.min(parseInt(searchParams.get('maxResults') || '50'), 100);

    if (!pattern) {
      return NextResponse.json(
        { error: 'Pattern parameter is required' },
        { status: 400 }
      );
    }

    // Check drive access
    const hasDriveAccess = await getUserDriveAccess(userId, driveId);
    if (!hasDriveAccess) {
      return NextResponse.json(
        { error: 'You don\'t have access to this drive' },
        { status: 403 }
      );
    }

    // Get drive info for semantic paths
    const [drive] = await db
      .select({ slug: drives.slug, name: drives.name })
      .from(drives)
      .where(eq(drives.id, driveId));

    if (!drive) {
      return NextResponse.json(
        { error: 'Drive not found' },
        { status: 404 }
      );
    }

    // Create regex for PostgreSQL - escape backslashes but preserve regex shortcuts
    const pgPattern = pattern.replace(/\\(?![dDwWsSbBntrvfAZzGQE])/g, '\\\\');

    // Build where conditions based on searchIn parameter
    let whereConditions;
    if (searchIn === 'content') {
      whereConditions = and(
        eq(pages.driveId, driveId),
        eq(pages.isTrashed, false),
        sql`${pages.content} ~ ${pgPattern}`
      );
    } else if (searchIn === 'title') {
      whereConditions = and(
        eq(pages.driveId, driveId),
        eq(pages.isTrashed, false),
        sql`${pages.title} ~ ${pgPattern}`
      );
    } else {
      whereConditions = and(
        eq(pages.driveId, driveId),
        eq(pages.isTrashed, false),
        sql`${pages.content} ~ ${pgPattern} OR ${pages.title} ~ ${pgPattern}`
      );
    }

    // Build final query
    const query = db
      .select({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        parentId: pages.parentId,
        content: pages.content,
      })
      .from(pages)
      .where(whereConditions);

    const matchingPages = await query.limit(maxResults);

    // Filter by permissions and build results
    const results = [];
    for (const page of matchingPages) {
      const accessLevel = await getUserAccessLevel(userId, page.id);
      if (accessLevel?.canView) {
        // Build semantic path
        const pathParts = [drive.slug || driveId];
        let currentPage = page;
        const parentChain = [];

        // Build parent chain
        while (currentPage.parentId) {
          const [parent] = await db
            .select({
              id: pages.id,
              title: pages.title,
              parentId: pages.parentId,
              type: pages.type,
              content: pages.content
            })
            .from(pages)
            .where(eq(pages.id, currentPage.parentId));
          if (parent) {
            parentChain.unshift(parent.title);
            currentPage = parent;
          } else {
            break;
          }
        }

        const semanticPath = `/${[...pathParts, ...parentChain, page.title].join('/')}`;

        // Extract matching lines if searching content
        const matchingLines: Array<{ lineNumber: number; content: string }> = [];
        if (searchIn !== 'title') {
          const lines = page.content.split('\n');
          const regex = new RegExp(pattern, 'g');
          lines.forEach((line, index) => {
            if (regex.test(line)) {
              matchingLines.push({
                lineNumber: index + 1,
                content: line.substring(0, 200), // Truncate long lines
              });
            }
          });
        }

        results.push({
          pageId: page.id,
          title: page.title,
          type: page.type,
          semanticPath,
          matchingLines: matchingLines.slice(0, 5), // Limit to first 5 matches
          totalMatches: matchingLines.length,
        });
      }
    }

    loggers.api.info('Regex search completed', {
      driveId,
      pattern,
      searchIn,
      resultCount: results.length,
      userId
    });

    return NextResponse.json({
      success: true,
      driveSlug: drive.slug,
      pattern,
      searchIn,
      results,
      totalResults: results.length,
      summary: `Found ${results.length} page${results.length === 1 ? '' : 's'} matching pattern "${pattern}"`,
      stats: {
        pagesScanned: matchingPages.length,
        pagesWithAccess: results.length,
        documentTypes: [...new Set(results.map(r => r.type))],
      },
      nextSteps: results.length > 0 ? [
        'Use read_page with the pageId to examine full content',
        'Use edit tools to modify matching pages',
        'Refine your regex pattern for more specific results',
      ] : [
        'Try a different pattern or search in a different location',
        'Check if the pattern syntax is correct for PostgreSQL regex',
      ]
    });

  } catch (error) {
    loggers.api.error('Error in regex search:', error as Error);
    return NextResponse.json(
      { error: `Regex search failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}

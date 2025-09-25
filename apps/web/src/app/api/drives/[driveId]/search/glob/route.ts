import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';

const AUTH_OPTIONS = { allow: ['jwt', 'mcp'] as const };
import { db, pages, drives, eq, and, inArray } from '@pagespace/db';
import { getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';

/**
 * GET /api/drives/[driveId]/search/glob
 * Find pages using glob-style patterns for titles and paths
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
    const includeTypesParam = searchParams.get('includeTypes');
    const maxResults = Math.min(parseInt(searchParams.get('maxResults') || '100'), 200);

    if (!pattern) {
      return NextResponse.json(
        { error: 'Pattern parameter is required' },
        { status: 400 }
      );
    }

    // Parse includeTypes
    const includeTypes = includeTypesParam ?
      includeTypesParam.split(',').filter(t => ['FOLDER', 'DOCUMENT', 'AI_CHAT', 'CHANNEL', 'CANVAS', 'SHEET'].includes(t)) :
      null;

    // Check drive access
    const hasDriveAccess = await getUserDriveAccess(userId, driveId);
    if (!hasDriveAccess) {
      return NextResponse.json(
        { error: 'You don\'t have access to this drive' },
        { status: 403 }
      );
    }

    // Get drive info
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

    // Build where conditions
    const whereConditions = includeTypes && includeTypes.length > 0
      ? and(
          eq(pages.driveId, driveId),
          eq(pages.isTrashed, false),
          inArray(pages.type, includeTypes as Array<'FOLDER' | 'DOCUMENT' | 'AI_CHAT' | 'CHANNEL' | 'CANVAS' | 'SHEET'>)
        )
      : and(
          eq(pages.driveId, driveId),
          eq(pages.isTrashed, false)
        );

    // Get all pages in drive
    const query = db
      .select({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        parentId: pages.parentId,
        position: pages.position,
      })
      .from(pages)
      .where(whereConditions);

    const allPages = await query;

    // Build page hierarchy with paths
    const pageMap = new Map();
    const results = [];

    // First pass: build page map
    for (const page of allPages) {
      pageMap.set(page.id, page);
    }

    // Convert glob pattern to regex
    const globToRegex = (glob: string): RegExp => {
      const escaped = glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except * and ?
        .replace(/\*/g, '.*')  // * matches any characters
        .replace(/\?/g, '.');   // ? matches single character
      return new RegExp(`^${escaped}$`, 'i');
    };

    const pathRegex = globToRegex(pattern);

    // Second pass: build paths and check pattern
    for (const page of allPages) {
      // Check permissions
      const accessLevel = await getUserAccessLevel(userId, page.id);
      if (!accessLevel?.canView) continue;

      // Build full path
      const pathParts = [];
      let currentPage = page;

      while (currentPage) {
        pathParts.unshift(currentPage.title);
        if (currentPage.parentId) {
          currentPage = pageMap.get(currentPage.parentId);
        } else {
          break;
        }
      }

      const fullPath = pathParts.join('/');
      const semanticPath = `/${drive.slug || driveId}/${fullPath}`;

      // Check if path matches pattern
      if (pathRegex.test(fullPath) || pathRegex.test(page.title)) {
        results.push({
          pageId: page.id,
          title: page.title,
          type: page.type,
          semanticPath,
          matchedOn: pathRegex.test(fullPath) ? 'path' : 'title',
        });

        if (results.length >= maxResults) break;
      }
    }

    // Sort results by path for better organization
    results.sort((a, b) => a.semanticPath.localeCompare(b.semanticPath));

    loggers.api.info('Glob search completed', {
      driveId,
      pattern,
      includeTypes,
      resultCount: results.length,
      userId
    });

    return NextResponse.json({
      success: true,
      driveSlug: drive.slug,
      pattern,
      results,
      totalResults: results.length,
      summary: `Found ${results.length} page${results.length === 1 ? '' : 's'} matching pattern "${pattern}"`,
      stats: {
        totalPagesScanned: allPages.length,
        matchingPages: results.length,
        documentTypes: [...new Set(results.map(r => r.type))],
        matchTypes: {
          path: results.filter(r => r.matchedOn === 'path').length,
          title: results.filter(r => r.matchedOn === 'title').length,
        }
      },
      nextSteps: results.length > 0 ? [
        'Use read_page with the pageId to examine content',
        'Use the semantic paths to understand the structure',
        'Consider using regex_search for content-based searching',
      ] : [
        'Try a broader pattern (e.g., "**/*" for all pages)',
        'Check if your pattern syntax is correct',
        'Verify the pages exist with list_pages',
      ]
    });

  } catch (error) {
    loggers.api.error('Error in glob search:', error as Error);
    return NextResponse.json(
      { error: `Glob search failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}

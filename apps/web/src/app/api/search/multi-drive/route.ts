import { NextResponse } from 'next/server';
import { authenticateRequestWithOptions, isAuthError } from '@/lib/auth';
import { db, pages, drives, eq, and, sql, inArray } from '@pagespace/db';
import { getBatchPagePermissions, getDriveIdsForUser } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/server';
import { parseBoundedIntParam } from '@/lib/utils/query-params';

const AUTH_OPTIONS = { allow: ['session', 'mcp'] as const };

/**
 * GET /api/search/multi-drive
 * Search for content across multiple drives at once
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestWithOptions(request, AUTH_OPTIONS);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { searchParams } = new URL(request.url);
    const searchQuery = searchParams.get('searchQuery');
    const searchType = searchParams.get('searchType') || 'text';
    const maxResultsPerDrive = parseBoundedIntParam(searchParams.get('maxResultsPerDrive'), {
      defaultValue: 20,
      min: 1,
      max: 50,
    });

    if (!searchQuery) {
      return NextResponse.json(
        { error: 'searchQuery parameter is required' },
        { status: 400 }
      );
    }

    if (!['text', 'regex'].includes(searchType)) {
      return NextResponse.json(
        { error: 'searchType must be "text" or "regex"' },
        { status: 400 }
      );
    }

    // Get drive IDs accessible by this user without scanning all drives.
    const accessibleDriveIds = await getDriveIdsForUser(userId);
    if (accessibleDriveIds.length === 0) {
      return NextResponse.json({
        success: true,
        searchQuery,
        searchType,
        results: [],
        totalDrives: 0,
        totalMatches: 0,
        summary: 'Found 0 matches across 0 drives',
        stats: {
          drivesSearched: 0,
          drivesWithResults: 0,
          totalMatches: 0,
        },
        nextSteps: [
          'Try a different search query',
          'Check if you have access to the expected drives',
          'Use list_drives to see available workspaces',
        ],
      });
    }

    const accessibleDrives = await db
      .select({
        id: drives.id,
        name: drives.name,
        slug: drives.slug,
      })
      .from(drives)
      .where(and(
        eq(drives.isTrashed, false),
        inArray(drives.id, accessibleDriveIds)
      ));

    if (accessibleDrives.length === 0) {
      return NextResponse.json({
        success: true,
        searchQuery,
        searchType,
        results: [],
        totalDrives: 0,
        totalMatches: 0,
        summary: 'Found 0 matches across 0 drives',
        stats: {
          drivesSearched: 0,
          drivesWithResults: 0,
          totalMatches: 0,
        },
        nextSteps: [
          'Try a different search query',
          'Check if you have access to the expected drives',
          'Use list_drives to see available workspaces',
        ],
      });
    }

    // Run one ranked query across all accessible drives, enforcing per-drive caps
    // at the database layer (no per-drive loop queries).
    const driveIds = accessibleDrives.map((drive) => drive.id);
    const regexPattern = searchQuery.replace(/\\(?![dDwWsSbBntrvfAZzGQE])/g, '\\\\');
    const searchPattern = `%${searchQuery}%`;
    const searchCondition = searchType === 'regex'
      ? sql`${pages.content} ~ ${regexPattern} OR ${pages.title} ~ ${regexPattern}`
      : sql`${pages.content} ILIKE ${searchPattern} OR ${pages.title} ILIKE ${searchPattern}`;

    const rankedMatches = db
      .select({
        id: pages.id,
        title: pages.title,
        type: pages.type,
        content: pages.content,
        driveId: pages.driveId,
        rowNumber: sql<number>`ROW_NUMBER() OVER (PARTITION BY ${pages.driveId} ORDER BY ${pages.updatedAt} DESC, ${pages.id} DESC)`.as('row_number'),
      })
      .from(pages)
      .where(and(
        inArray(pages.driveId, driveIds),
        eq(pages.isTrashed, false),
        searchCondition
      ))
      .as('ranked_matches');

    const rankedResults = await db
      .select({
        id: rankedMatches.id,
        title: rankedMatches.title,
        type: rankedMatches.type,
        content: rankedMatches.content,
        driveId: rankedMatches.driveId,
      })
      .from(rankedMatches)
      .where(sql`${rankedMatches.rowNumber} <= ${maxResultsPerDrive}`);

    const driveMap = new Map(accessibleDrives.map((drive) => [drive.id, drive]));

    const results: Array<{
      driveId: string;
      driveName: string;
      driveSlug: string;
      matches: Array<{
        pageId: string;
        title: string;
        type: string;
        excerpt: string;
      }>;
      count: number;
    }> = [];

    // Collect all search results for batch permission checking.
    const allSearchResults: Array<{
      page: {
        id: string;
        title: string;
        type: string;
        content: string;
      };
      driveId: string;
      driveName: string;
      driveSlug: string;
    }> = [];

    for (const page of rankedResults) {
      const drive = driveMap.get(page.driveId);
      if (!drive) continue;

      allSearchResults.push({
        page: {
          id: page.id,
          title: page.title,
          type: page.type,
          content: page.content,
        },
        driveId: drive.id,
        driveName: drive.name,
        driveSlug: drive.slug,
      });
    }

    // Batch check permissions for all search results at once
    const allPageIds = allSearchResults.map(result => result.page.id);
    const permissionsMap = await getBatchPagePermissions(userId, allPageIds);

    // Group results by drive and filter by permissions
    const driveResultsMap = new Map<string, Array<{
      pageId: string;
      title: string;
      type: string;
      excerpt: string;
    }>>();

    for (const { page, driveId } of allSearchResults) {
      const permissions = permissionsMap.get(page.id);
      if (permissions?.canView) {
        if (!driveResultsMap.has(driveId)) {
          driveResultsMap.set(driveId, []);
        }

        driveResultsMap.get(driveId)!.push({
          pageId: page.id,
          title: page.title,
          type: page.type,
          excerpt: page.content.substring(0, 150) + '...',
        });
      }
    }

    // Build final results structure
    for (const drive of accessibleDrives) {
      const driveResults = driveResultsMap.get(drive.id) || [];
      if (driveResults.length > 0) {
        results.push({
          driveId: drive.id,
          driveName: drive.name,
          driveSlug: drive.slug,
          matches: driveResults,
          count: driveResults.length,
        });
      }
    }

    const totalMatches = results.reduce((sum, r) => sum + r.count, 0);

    loggers.api.info('Multi-drive search completed', {
      searchQuery,
      searchType,
      resultCount: totalMatches,
      driveCount: results.length,
      userId
    });

    return NextResponse.json({
      success: true,
      searchQuery,
      searchType,
      results,
      totalDrives: results.length,
      totalMatches,
      summary: `Found ${totalMatches} matches across ${results.length} drive${results.length === 1 ? '' : 's'}`,
      stats: {
        drivesSearched: accessibleDrives.length,
        drivesWithResults: results.length,
        totalMatches,
      },
      nextSteps: results.length > 0 ? [
        'Use read_page with specific pageIds to examine content',
        'Focus on a specific drive for more detailed search',
        'Use regex_search or glob_search for more precise patterns',
      ] : [
        'Try a different search query',
        'Check if you have access to the expected drives',
        'Use list_drives to see available workspaces',
      ]
    });

  } catch (error) {
    loggers.api.error('Error in multi-drive search:', error as Error);
    return NextResponse.json(
      { error: 'Multi-drive search failed' },
      { status: 500 }
    );
  }
}

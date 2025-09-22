import { NextResponse } from 'next/server';
import { authenticateMCPRequest, isAuthError } from '@/lib/auth';
import { db, pages, drives, eq, and, sql } from '@pagespace/db';
import { getUserAccessLevel, getUserDriveAccess } from '@pagespace/lib/server';
import { loggers } from '@pagespace/lib/logger-config';

/**
 * GET /api/search/multi-drive
 * Search for content across multiple drives at once
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateMCPRequest(request);
    if (isAuthError(auth)) return auth.error;
    const { userId } = auth;

    const { searchParams } = new URL(request.url);
    const searchQuery = searchParams.get('searchQuery');
    const searchType = searchParams.get('searchType') || 'text';
    const maxResultsPerDrive = Math.min(parseInt(searchParams.get('maxResultsPerDrive') || '20'), 50);

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

    // Get all drives user has access to
    const userDrives = await db
      .selectDistinct({
        id: drives.id,
        name: drives.name,
        slug: drives.slug,
      })
      .from(drives)
      .where(eq(drives.isTrashed, false));

    const results = [];

    for (const drive of userDrives) {
      // Check drive access
      const hasDriveAccess = await getUserDriveAccess(userId, drive.id);
      if (!hasDriveAccess) continue;

      // Build search conditions
      let searchWhereConditions;
      if (searchType === 'regex') {
        const pgPattern = searchQuery.replace(/\\(?![dDwWsSbBntrvfAZzGQE])/g, '\\\\');
        searchWhereConditions = and(
          eq(pages.driveId, drive.id),
          eq(pages.isTrashed, false),
          sql`${pages.content} ~ ${pgPattern} OR ${pages.title} ~ ${pgPattern}`
        );
      } else {
        const searchPattern = `%${searchQuery}%`;
        searchWhereConditions = and(
          eq(pages.driveId, drive.id),
          eq(pages.isTrashed, false),
          sql`${pages.content} ILIKE ${searchPattern} OR ${pages.title} ILIKE ${searchPattern}`
        );
      }

      // Search in this drive
      const driveQuery = db
        .select({
          id: pages.id,
          title: pages.title,
          type: pages.type,
          content: pages.content,
        })
        .from(pages)
        .where(searchWhereConditions);

      const drivePages = await driveQuery.limit(maxResultsPerDrive);

      // Filter by permissions
      const driveResults = [];
      for (const page of drivePages) {
        const accessLevel = await getUserAccessLevel(userId, page.id);
        if (accessLevel?.canView) {
          driveResults.push({
            pageId: page.id,
            title: page.title,
            type: page.type,
            excerpt: page.content.substring(0, 150) + '...',
          });
        }
      }

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
        drivesSearched: userDrives.length,
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
      { error: `Multi-drive search failed: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 }
    );
  }
}